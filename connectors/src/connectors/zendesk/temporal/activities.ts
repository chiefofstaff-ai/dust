import type { ModelId } from "@dust-tt/types";
import { MIME_TYPES } from "@dust-tt/types";
import _ from "lodash";

import { getBrandInternalId } from "@connectors/connectors/zendesk/lib/id_conversions";
import { syncArticle } from "@connectors/connectors/zendesk/lib/sync_article";
import { syncCategory } from "@connectors/connectors/zendesk/lib/sync_category";
import { syncTicket } from "@connectors/connectors/zendesk/lib/sync_ticket";
import { getZendeskSubdomainAndAccessToken } from "@connectors/connectors/zendesk/lib/zendesk_access_token";
import {
  changeZendeskClientSubdomain,
  createZendeskClient,
  fetchZendeskArticlesInCategory,
  fetchZendeskBrand,
  fetchZendeskCategoriesInBrand,
  fetchZendeskManyUsers,
  fetchZendeskTicketComments,
  fetchZendeskTickets,
  getZendeskBrandSubdomain,
} from "@connectors/connectors/zendesk/lib/zendesk_api";
import { ZENDESK_BATCH_SIZE } from "@connectors/connectors/zendesk/temporal/config";
import { dataSourceConfigFromConnector } from "@connectors/lib/api/data_source_config";
import { concurrentExecutor } from "@connectors/lib/async_utils";
import { upsertDataSourceFolder } from "@connectors/lib/data_sources";
import { ZendeskTimestampCursor } from "@connectors/lib/models/zendesk";
import { syncStarted, syncSucceeded } from "@connectors/lib/sync_status";
import { heartbeat } from "@connectors/lib/temporal";
import logger from "@connectors/logger/logger";
import { ConnectorResource } from "@connectors/resources/connector_resource";
import {
  ZendeskBrandResource,
  ZendeskCategoryResource,
  ZendeskConfigurationResource,
} from "@connectors/resources/zendesk_resources";

/**
 * This activity is responsible for updating the lastSyncStartTime of the connector to now.
 */
export async function zendeskConnectorStartSync(
  connectorId: ModelId
): Promise<{ cursor: Date | null }> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error("[Zendesk] Connector not found.");
  }
  const res = await syncStarted(connector.id);
  if (res.isErr()) {
    throw res.error;
  }
  const cursor = await ZendeskTimestampCursor.findOne({
    where: { connectorId },
  });

  return { cursor: cursor?.timestampCursor ?? null };
}

/**
 * This activity is responsible for updating the sync status of the connector to "success".
 */
export async function saveZendeskConnectorSuccessSync(
  connectorId: ModelId,
  currentSyncDateMs: number
) {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error("[Zendesk] Connector not found.");
  }

  // initializing the timestamp cursor if it does not exist (first sync, not incremental)
  const cursors = await ZendeskTimestampCursor.findOne({
    where: { connectorId },
  });
  if (!cursors) {
    await ZendeskTimestampCursor.create({
      connectorId,
      timestampCursor: new Date(currentSyncDateMs),
    });
  }

  const res = await syncSucceeded(connector.id);
  if (res.isErr()) {
    throw res.error;
  }
}

/**
 * This activity is responsible for syncing a Brand.
 * It does not sync the content inside the Brand, only the Brand data in itself (name, url, subdomain, lastUpsertedTs).
 * If the brand is not found in Zendesk, it deletes it.
 *
 * @returns the permissions of the Brand.
 */
export async function syncZendeskBrandActivity({
  connectorId,
  brandId,
  currentSyncDateMs,
}: {
  connectorId: ModelId;
  brandId: number;
  currentSyncDateMs: number;
}): Promise<{ helpCenterAllowed: boolean; ticketsAllowed: boolean }> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error("[Zendesk] Connector not found.");
  }

  const brandInDb = await ZendeskBrandResource.fetchByBrandId({
    connectorId,
    brandId,
  });
  if (!brandInDb) {
    throw new Error(
      `[Zendesk] Brand not found, connectorId: ${connectorId}, brandId: ${brandId}`
    );
  }

  const zendeskApiClient = createZendeskClient(
    await getZendeskSubdomainAndAccessToken(connector.connectionId)
  );
  const {
    result: { brand: fetchedBrand },
  } = await zendeskApiClient.brand.show(brandId);

  // if the brand is not on Zendesk anymore, we delete it
  if (!fetchedBrand) {
    await brandInDb.revokeTicketsPermissions();
    await brandInDb.revokeHelpCenterPermissions();
    return { helpCenterAllowed: false, ticketsAllowed: false };
  }

  // upserting three folders to data_sources_folders (core): brand, help center, tickets
  const dataSourceConfig = dataSourceConfigFromConnector(connector);

  const brandInternalId = getBrandInternalId({ connectorId, brandId });
  await upsertDataSourceFolder({
    dataSourceConfig,
    folderId: brandInternalId,
    parents: [brandInternalId],
    parentId: null,
    title: brandInDb.name,
    mimeType: MIME_TYPES.ZENDESK.BRAND,
    sourceUrl: fetchedBrand?.url || brandInDb.url,
  });

  // using the content node to get one source of truth regarding the parent relationship
  const helpCenterNode = brandInDb.getHelpCenterContentNode(connectorId);
  await upsertDataSourceFolder({
    dataSourceConfig,
    folderId: helpCenterNode.internalId,
    parents: [helpCenterNode.internalId, helpCenterNode.parentInternalId],
    parentId: helpCenterNode.parentInternalId,
    title: helpCenterNode.title,
    mimeType: MIME_TYPES.ZENDESK.HELP_CENTER,
  });

  // using the content node to get one source of truth regarding the parent relationship
  const ticketsNode = brandInDb.getTicketsContentNode(connectorId);
  await upsertDataSourceFolder({
    dataSourceConfig,
    folderId: ticketsNode.internalId,
    parents: [ticketsNode.internalId, ticketsNode.parentInternalId],
    parentId: ticketsNode.parentInternalId,
    title: ticketsNode.title,
    mimeType: MIME_TYPES.ZENDESK.TICKETS,
  });

  // updating the entry in db
  await brandInDb.update({
    name: fetchedBrand.name || "Brand",
    url: fetchedBrand?.url || brandInDb.url,
    subdomain: fetchedBrand?.subdomain || brandInDb.subdomain,
    lastUpsertedTs: new Date(currentSyncDateMs),
  });

  return {
    helpCenterAllowed: brandInDb.helpCenterPermission === "read",
    ticketsAllowed: brandInDb.ticketsPermission === "read",
  };
}

/**
 * Retrieves the IDs of every brand in db that has read permissions on their Help Center or in one of their Categories.
 * Removes the permissions beforehand for Help Center that have been deleted or disabled on Zendesk.
 * This activity will be used to retrieve the brands that need to be incrementally synced.
 *
 * Note: in this approach; if a single category has read permissions and not its Help Center,
 * diffs for the whole Help Center are fetched since there is no endpoint that returns the diff for the Category.
 */
export async function getZendeskHelpCenterReadAllowedBrandIdsActivity(
  connectorId: ModelId
): Promise<number[]> {
  // fetching the brands that have a Help Center selected as a whole
  const brandsWithHelpCenter =
    await ZendeskBrandResource.fetchHelpCenterReadAllowedBrandIds(connectorId);

  // cleaning up Brands (resp. Help Centers) that don't exist on Zendesk anymore (resp. have been deleted)
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error("[Zendesk] Connector not found.");
  }
  const { subdomain, accessToken } = await getZendeskSubdomainAndAccessToken(
    connector.connectionId
  );
  for (const brandId of brandsWithHelpCenter) {
    const fetchedBrand = await fetchZendeskBrand({
      accessToken,
      subdomain,
      brandId,
    });
    const brandInDb = await ZendeskBrandResource.fetchByBrandId({
      connectorId,
      brandId,
    });
    if (!fetchedBrand) {
      await brandInDb?.revokeTicketsPermissions();
      await brandInDb?.revokeHelpCenterPermissions();
    } else if (!fetchedBrand.has_help_center) {
      await brandInDb?.revokeHelpCenterPermissions();
    }
  }

  // fetching the brands that have at least one Category selected:
  // we need to do that because we can only fetch diffs at the brand level.
  // We will filter later on the categories allowed.
  const brandWithCategories =
    await ZendeskCategoryResource.fetchBrandIdsOfReadOnlyCategories(
      connectorId
    );
  // removing duplicates
  return [...new Set([...brandsWithHelpCenter, ...brandWithCategories])];
}

/**
 * Retrieves the IDs of every brand stored in db that has read permissions on their Tickets.
 */
export async function getZendeskTicketsAllowedBrandIdsActivity(
  connectorId: ModelId
): Promise<number[]> {
  return ZendeskBrandResource.fetchTicketsAllowedBrandIds(connectorId);
}

/**
 * This activity is responsible for syncing a batch of Categories.
 * It does not sync the articles inside the Category, only the Category data in itself.
 *
 * It is going to update the Categories if they have changed on Zendesk
 */
export async function syncZendeskCategoryBatchActivity({
  connectorId,
  brandId,
  currentSyncDateMs,
  url,
}: {
  connectorId: ModelId;
  brandId: number;
  currentSyncDateMs: number;
  url: string | null;
}): Promise<{
  categoriesToUpdate: number[];
  hasMore: boolean;
  nextLink: string | null;
}> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error("[Zendesk] Connector not found.");
  }
  const dataSourceConfig = dataSourceConfigFromConnector(connector);

  const { accessToken, subdomain } = await getZendeskSubdomainAndAccessToken(
    connector.connectionId
  );
  const brandSubdomain = await getZendeskBrandSubdomain({
    brandId,
    connectorId,
    accessToken,
    subdomain,
  });

  const { categories, hasMore, nextLink } = await fetchZendeskCategoriesInBrand(
    accessToken,
    url ? { url } : { brandSubdomain, pageSize: ZENDESK_BATCH_SIZE }
  );

  await concurrentExecutor(
    categories,
    async (category) => {
      return syncCategory({
        connectorId,
        brandId,
        category,
        currentSyncDateMs,
        dataSourceConfig,
      });
    },
    {
      concurrency: 10,
      onBatchComplete: heartbeat,
    }
  );

  return {
    categoriesToUpdate: categories.map((category) => category.id),
    hasMore,
    nextLink,
  };
}

/**
 * This activity is responsible for syncing a single Category.
 * It does not sync the articles inside the Category, only the Category data in itself.
 *
 * It is going to update the name, description and URL of the Category if they have changed.
 * If the Category is not present on Zendesk anymore, it will delete all its data as well.
 */
export async function syncZendeskCategoryActivity({
  connectorId,
  categoryId,
  brandId,
  currentSyncDateMs,
}: {
  connectorId: ModelId;
  categoryId: number;
  brandId: number;
  currentSyncDateMs: number;
}): Promise<{ shouldSyncArticles: boolean }> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error("[Zendesk] Connector not found.");
  }
  const categoryInDb = await ZendeskCategoryResource.fetchByCategoryId({
    connectorId,
    brandId,
    categoryId,
  });
  if (!categoryInDb) {
    throw new Error(
      `[Zendesk] Category not found, connectorId: ${connectorId}, categoryId: ${categoryId}`
    );
  }

  // if all rights were revoked, we have nothing to sync
  if (categoryInDb.permission === "none") {
    return { shouldSyncArticles: false };
  }

  const zendeskApiClient = createZendeskClient(
    await getZendeskSubdomainAndAccessToken(connector.connectionId)
  );
  await changeZendeskClientSubdomain(zendeskApiClient, {
    connectorId,
    brandId,
  });

  // if the category is not on Zendesk anymore, we remove its permissions
  const { result: fetchedCategory } =
    await zendeskApiClient.helpcenter.categories.show(categoryId);
  if (!fetchedCategory) {
    await categoryInDb.revokePermissions();
    return { shouldSyncArticles: false };
  }

  // upserting a folder to data_sources_folders (core)
  const parents = categoryInDb.getParentInternalIds(connectorId);
  await upsertDataSourceFolder({
    dataSourceConfig: dataSourceConfigFromConnector(connector),
    folderId: parents[0],
    parents,
    parentId: parents[1],
    title: categoryInDb.name,
    mimeType: MIME_TYPES.ZENDESK.CATEGORY,
    sourceUrl: fetchedCategory.html_url,
  });

  // otherwise, we update the category name and lastUpsertedTs
  await categoryInDb.update({
    name: fetchedCategory.name || "Category",
    url: fetchedCategory.html_url,
    description: fetchedCategory.description,
    lastUpsertedTs: new Date(currentSyncDateMs),
  });
  return { shouldSyncArticles: true };
}

/**
 * This activity is responsible for syncing the next batch of articles to process.
 * It does not sync the Category, only the Articles.
 */
export async function syncZendeskArticleBatchActivity({
  connectorId,
  brandId,
  categoryId,
  currentSyncDateMs,
  forceResync,
  url,
}: {
  connectorId: ModelId;
  brandId: number;
  categoryId: number;
  currentSyncDateMs: number;
  forceResync: boolean;
  url: string | null;
}): Promise<{ hasMore: boolean; nextLink: string | null }> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error("[Zendesk] Connector not found.");
  }
  const dataSourceConfig = dataSourceConfigFromConnector(connector);
  const loggerArgs = {
    workspaceId: dataSourceConfig.workspaceId,
    connectorId,
    provider: "zendesk",
    dataSourceId: dataSourceConfig.dataSourceId,
  };
  const category = await ZendeskCategoryResource.fetchByCategoryId({
    connectorId,
    brandId,
    categoryId,
  });
  if (!category) {
    throw new Error(
      `[Zendesk] Category not found, connectorId: ${connectorId}, categoryId: ${categoryId}`
    );
  }

  const { accessToken, subdomain } = await getZendeskSubdomainAndAccessToken(
    connector.connectionId
  );
  const zendeskApiClient = createZendeskClient({ accessToken, subdomain });
  const brandSubdomain = await changeZendeskClientSubdomain(zendeskApiClient, {
    brandId: category.brandId,
    connectorId,
  });

  const { articles, hasMore, nextLink } = await fetchZendeskArticlesInCategory(
    category,
    accessToken,
    url ? { url } : { brandSubdomain, pageSize: ZENDESK_BATCH_SIZE }
  );

  logger.info(
    { ...loggerArgs, articlesSynced: articles.length },
    `[Zendesk] Processing ${articles.length} articles in batch`
  );

  const sections =
    await zendeskApiClient.helpcenter.sections.listByCategory(categoryId);
  const users = await fetchZendeskManyUsers({
    accessToken,
    brandSubdomain,
    userIds: articles.map((article) => article.author_id),
  });

  await concurrentExecutor(
    articles,
    (article) =>
      syncArticle({
        connectorId,
        category,
        article,
        section:
          sections.find((section) => section.id === article.section_id) || null,
        user: users.find((user) => user.id === article.author_id) || null,
        dataSourceConfig,
        currentSyncDateMs,
        loggerArgs,
        forceResync,
      }),
    {
      concurrency: 10,
      onBatchComplete: heartbeat,
    }
  );
  return { hasMore, nextLink };
}

/**
 * This activity is responsible for syncing the next batch of tickets to process.
 */
export async function syncZendeskTicketBatchActivity({
  connectorId,
  brandId,
  currentSyncDateMs,
  forceResync,
  url,
}: {
  connectorId: ModelId;
  brandId: number;
  currentSyncDateMs: number;
  forceResync: boolean;
  url: string | null;
}): Promise<{ hasMore: boolean; nextLink: string | null }> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error("[Zendesk] Connector not found.");
  }
  const configuration =
    await ZendeskConfigurationResource.fetchByConnectorId(connectorId);
  if (!configuration) {
    throw new Error(`[Zendesk] Configuration not found.`);
  }
  const dataSourceConfig = dataSourceConfigFromConnector(connector);
  const loggerArgs = {
    workspaceId: dataSourceConfig.workspaceId,
    connectorId,
    provider: "zendesk",
    dataSourceId: dataSourceConfig.dataSourceId,
  };

  const { subdomain, accessToken } = await getZendeskSubdomainAndAccessToken(
    connector.connectionId
  );
  const brandSubdomain = await getZendeskBrandSubdomain({
    connectorId,
    brandId,
    accessToken,
    subdomain,
  });

  const startTime =
    Math.floor(currentSyncDateMs / 1000) -
    configuration.retentionPeriodDays * 24 * 60 * 60; // days to seconds
  const { tickets, hasMore, nextLink } = await fetchZendeskTickets(
    accessToken,
    url ? { url } : { brandSubdomain, startTime }
  );

  if (tickets.length === 0) {
    logger.info(
      { ...loggerArgs, ticketsSynced: 0 },
      `[Zendesk] No tickets to process in batch - stopping.`
    );
    return { hasMore: false, nextLink: "" };
  }

  const closedTickets = tickets.filter((t) =>
    ["closed", "solved"].includes(t.status)
  );

  const comments2d = await concurrentExecutor(
    closedTickets,
    async (ticket) =>
      fetchZendeskTicketComments({
        accessToken,
        brandSubdomain,
        ticketId: ticket.id,
      }),
    { concurrency: 3, onBatchComplete: heartbeat }
  );
  const users = await fetchZendeskManyUsers({
    accessToken,
    brandSubdomain,
    userIds: [
      ...new Set(
        comments2d.flatMap((comments) => comments.map((c) => c.author_id))
      ),
    ],
  });

  const res = await concurrentExecutor(
    _.zip(closedTickets, comments2d),
    async ([ticket, comments]) => {
      if (!ticket || !comments) {
        throw new Error(
          `[Zendesk] Unreachable: Ticket or comments not found, ticket: ${ticket}, comments: ${comments}`
        );
      }

      return syncTicket({
        connectorId,
        brandId,
        ticket,
        dataSourceConfig,
        currentSyncDateMs,
        loggerArgs,
        forceResync,
        comments,
        users,
      });
    },
    {
      concurrency: 10,
      onBatchComplete: heartbeat,
    }
  );

  logger.info(
    { ...loggerArgs, ticketsSynced: res.filter((r) => r).length },
    `[Zendesk] Processing ${res.length} tickets in batch`
  );

  return { hasMore, nextLink };
}
