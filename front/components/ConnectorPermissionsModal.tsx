import { Modal, Page } from "@dust-tt/sparkle";
import {
  ConnectorProvider,
  DataSourceType,
  WorkspaceType,
} from "@dust-tt/types";
import { ConnectorPermission, ConnectorType } from "@dust-tt/types";
import { useContext, useState } from "react";
import { useSWRConfig } from "swr";

import { CONNECTOR_CONFIGURATIONS } from "@app/lib/connector_providers";
import { useConnectorDefaultNewResourcePermission } from "@app/lib/swr";

import { PermissionTree } from "./ConnectorPermissionsTree";
import { SendNotificationsContext } from "./sparkle/Notification";

const PERMISSIONS_EDITABLE_CONNECTOR_TYPES: Set<ConnectorProvider> = new Set([
  "slack",
  "google_drive",
]);

export default function ConnectorPermissionsModal({
  owner,
  connector,
  dataSource,
  isOpen,
  setOpen,
}: {
  owner: WorkspaceType;
  connector: ConnectorType;
  dataSource: DataSourceType;
  isOpen: boolean;
  setOpen: (open: boolean) => void;
}) {
  const { mutate } = useSWRConfig();

  const [updatedPermissionByInternalId, setUpdatedPermissionByInternalId] =
    useState<Record<string, ConnectorPermission>>({});

  const [saving, setSaving] = useState(false);
  const sendNotification = useContext(SendNotificationsContext);

  const {
    defaultNewResourcePermission,
    isDefaultNewResourcePermissionLoading,
    isDefaultNewResourcePermissionError,
  } = useConnectorDefaultNewResourcePermission(owner, dataSource);

  const [
    automaticallyIncludeNewResources,
    setAutomaticallyIncludeNewResources,
  ] = useState<null | boolean>(null);

  function closeModal() {
    setOpen(false);
    setTimeout(() => {
      setUpdatedPermissionByInternalId({});
      setAutomaticallyIncludeNewResources(null);
    }, 300);
  }

  const canUpdatePermissions = PERMISSIONS_EDITABLE_CONNECTOR_TYPES.has(
    connector.type
  );

  async function save() {
    setSaving(true);
    try {
      if (Object.keys(updatedPermissionByInternalId).length) {
        const r = await fetch(
          `/api/w/${owner.sId}/data_sources/${dataSource.name}/managed/permissions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              resources: Object.keys(updatedPermissionByInternalId).map(
                (internalId) => ({
                  internal_id: internalId,
                  permission: updatedPermissionByInternalId[internalId],
                })
              ),
            }),
          }
        );

        if (!r.ok) {
          const error: { error: { message: string } } = await r.json();
          window.alert(error.error.message);
        }

        await mutate(
          (key) =>
            typeof key === "string" &&
            key.startsWith(
              `/api/w/${owner.sId}/data_sources/${dataSource.name}/managed/permissions`
            )
        );
      }

      if (automaticallyIncludeNewResources !== null) {
        const newPermission = automaticallyIncludeNewResources
          ? "read_write"
          : "write";

        if (newPermission !== defaultNewResourcePermission) {
          const r = await fetch(
            `/api/w/${owner.sId}/data_sources/${dataSource.name}/managed/update`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                defaultNewResourcePermission: newPermission,
              }),
            }
          );

          if (!r.ok) {
            window.alert("An unexpected error occurred");
          }

          await mutate(
            `/api/w/${owner.sId}/data_sources/${dataSource.name}/managed/permissions/default`
          );
        }
      }
      closeModal();
    } catch (e) {
      sendNotification({
        type: "error",
        title: "Error saving permissions",
        description: "An unexpected error occurred while saving permissions.",
      });
      console.error(e);
    }
    setSaving(false);
  }

  return (
    <Modal
      title="Add / Remove data"
      isOpen={isOpen}
      onClose={closeModal}
      onSave={save}
      saveLabel="Save"
      savingLabel="Saving..."
      isSaving={saving}
      hasChanged={
        !!Object.keys(updatedPermissionByInternalId).length ||
        automaticallyIncludeNewResources !== null
      }
      variant="full-screen"
    >
      <div className="mx-auto max-w-4xl text-left">
        {!isDefaultNewResourcePermissionLoading &&
        defaultNewResourcePermission ? (
          <div className="flex flex-col pt-12">
            <Page.Vertical align="stretch" gap="xl">
              <Page.Header
                title="Make available to the workspace"
                description={`Selected resources will be accessible to all members of the workspace.`}
              />
              <div className="mx-2 mb-16 w-full">
                <PermissionTree
                  owner={owner}
                  dataSource={dataSource}
                  canUpdatePermissions={canUpdatePermissions}
                  onPermissionUpdate={({ internalId, permission }) => {
                    setUpdatedPermissionByInternalId((prev) => ({
                      ...prev,
                      [internalId]: permission,
                    }));
                  }}
                  showExpand={
                    CONNECTOR_CONFIGURATIONS[connector.type]?.isNested
                  }
                />
              </div>
            </Page.Vertical>
          </div>
        ) : null}
        {isDefaultNewResourcePermissionError && (
          <div className="text-red-300">An unexpected error occurred</div>
        )}
      </div>
    </Modal>
  );
}
