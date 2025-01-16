import { Page, useSendNotification } from "@dust-tt/sparkle";
import type {
  AgentMention,
  LightAgentConfigurationType,
  MentionType,
  Result,
  SubscriptionType,
  UploadedContentFragment,
  UserType,
  WorkspaceType,
} from "@dust-tt/types";
import { Err, Ok } from "@dust-tt/types";
import { useRouter } from "next/router";
import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { ReachedLimitPopup } from "@app/components/app/ReachedLimitPopup";
import { AssistantBrowserContainer } from "@app/components/assistant/conversation/AssistantBrowserContainer";
import { useConversationsNavigation } from "@app/components/assistant/conversation/ConversationsNavigationProvider";
import ConversationViewer from "@app/components/assistant/conversation/ConversationViewer";
import { FixedAssistantInputBar } from "@app/components/assistant/conversation/input_bar/InputBar";
import { InputBarContext } from "@app/components/assistant/conversation/input_bar/InputBarContext";
import {
  createConversationWithMessage,
  createPlaceholderUserMessage,
  submitMessage,
} from "@app/components/assistant/conversation/lib";
import { DropzoneContainer } from "@app/components/misc/DropzoneContainer";
import { updateMessagePagesWithOptimisticData } from "@app/lib/client/conversation/event_handlers";
import { getRandomGreetingForName } from "@app/lib/client/greetings";
import type { DustError } from "@app/lib/error";
import {
  useConversationMessages,
  useConversations,
} from "@app/lib/swr/conversations";

interface ConversationContainerProps {
  owner: WorkspaceType;
  subscription: SubscriptionType;
  user: UserType;
  isBuilder: boolean;
  agentIdToMention: string | null;
}

export function ConversationContainer({
  owner,
  subscription,
  user,
  isBuilder,
  agentIdToMention,
}: ConversationContainerProps) {
  const { activeConversationId } = useConversationsNavigation();

  const [planLimitReached, setPlanLimitReached] = useState(false);
  const [stickyMentions, setStickyMentions] = useState<AgentMention[]>([]);

  const { animate, setAnimate, setSelectedAssistant } =
    useContext(InputBarContext);

  const assistantToMention = useRef<LightAgentConfigurationType | null>(null);
  const { scrollConversationsToTop } = useConversationsNavigation();

  const router = useRouter();

  const sendNotification = useSendNotification();

  const { mutateConversations } = useConversations({
    workspaceId: owner.sId,
  });

  const { mutateMessages } = useConversationMessages({
    conversationId: activeConversationId,
    workspaceId: owner.sId,
    limit: 50,
  });

  const setInputbarMention = useCallback(
    (agentId: string) => {
      setSelectedAssistant({ configurationId: agentId });
      setAnimate(true);
    },
    [setAnimate, setSelectedAssistant]
  );

  useEffect(() => {
    if (agentIdToMention) {
      setInputbarMention(agentIdToMention);
    }
  }, [agentIdToMention, setInputbarMention]);

  useEffect(() => {
    if (animate) {
      setTimeout(() => setAnimate(false), 500);
    }
  });

  const handleSubmit = async (
    input: string,
    mentions: MentionType[],
    contentFragments: UploadedContentFragment[]
  ): Promise<Result<undefined, DustError>> => {
    if (!activeConversationId) {
      return new Err({
        code: "internal_error",
        name: "NoActiveConversation",
        message: "No active conversation",
      });
    }

    const messageData = { input, mentions, contentFragments };

    try {
      // Update the local state immediately and fire the
      // request. Since the API will return the updated
      // data, there is no need to start a new revalidation
      // and we can directly populate the cache.
      await mutateMessages(
        async (currentMessagePages) => {
          const result = await submitMessage({
            owner,
            user,
            conversationId: activeConversationId,
            messageData,
          });

          // Replace placeholder message with API response.
          if (result.isOk()) {
            const { message } = result.value;

            return updateMessagePagesWithOptimisticData(
              currentMessagePages,
              message
            );
          }

          if (result.error.type === "plan_limit_reached_error") {
            setPlanLimitReached(true);
          } else {
            sendNotification({
              title: result.error.title,
              description: result.error.message,
              type: "error",
            });
          }

          throw result.error;
        },
        {
          // Add optimistic data placeholder.
          optimisticData: (currentMessagePages) => {
            const lastMessageRank =
              currentMessagePages?.at(0)?.messages.at(-1)?.rank ?? 0;

            const placeholderMessage = createPlaceholderUserMessage({
              input,
              mentions,
              user,
              lastMessageRank,
            });
            return updateMessagePagesWithOptimisticData(
              currentMessagePages,
              placeholderMessage
            );
          },
          revalidate: false,
          // Rollback optimistic update on errors.
          rollbackOnError: true,
          populateCache: true,
        }
      );
      await mutateConversations();
      await scrollConversationsToTop();
    } catch (err) {
      // If the API errors, the original data will be
      // rolled back by SWR automatically.
      console.error("Failed to post message:", err);
      return new Err({
        code: "internal_error",
        name: "FailedToPostMessage",
        message: `Failed to post message ${err}`,
      });
    }

    return new Ok(undefined);
  };

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleConversationCreation = useCallback(
    async (
      input: string,
      mentions: MentionType[],
      contentFragments: UploadedContentFragment[]
    ): Promise<Result<undefined, DustError>> => {
      if (isSubmitting) {
        return new Err({
          code: "internal_error",
          name: "AlreadySubmitting",
          message: "Already submitting",
        });
      }

      setIsSubmitting(true);

      const conversationRes = await createConversationWithMessage({
        owner,
        user,
        messageData: {
          input,
          mentions,
          contentFragments,
        },
      });

      setIsSubmitting(false);

      if (conversationRes.isErr()) {
        if (conversationRes.error.type === "plan_limit_reached_error") {
          setPlanLimitReached(true);
        } else {
          sendNotification({
            title: conversationRes.error.title,
            description: conversationRes.error.message,
            type: "error",
          });
        }

        return new Err({
          code: "internal_error",
          name: conversationRes.error.title,
          message: conversationRes.error.message,
        });
      } else {
        // We start the push before creating the message to optimize for instantaneity as well.
        await router.push(
          `/w/${owner.sId}/assistant/${conversationRes.value.sId}`,
          undefined,
          { shallow: true }
        );
        await mutateConversations();
        await scrollConversationsToTop();

        return new Ok(undefined);
      }
    },
    [
      isSubmitting,
      owner,
      user,
      sendNotification,
      router,
      mutateConversations,
      scrollConversationsToTop,
    ]
  );

  useEffect(() => {
    const scrollContainerElement = document.getElementById(
      "assistant-input-header"
    );

    if (scrollContainerElement) {
      const observer = new IntersectionObserver(
        () => {
          if (assistantToMention.current) {
            setInputbarMention(assistantToMention.current.sId);
            assistantToMention.current = null;
          }
        },
        { threshold: 0.8 }
      );
      observer.observe(scrollContainerElement);
    }
    const handleRouteChange = (url: string) => {
      if (url.endsWith("/new")) {
        setSelectedAssistant(null);
        assistantToMention.current = null;
      }
    };
    router.events.on("routeChangeComplete", handleRouteChange);
  }, [setAnimate, setInputbarMention, router, setSelectedAssistant]);

  const [greeting, setGreeting] = useState<string>("");
  useEffect(() => {
    setGreeting(getRandomGreetingForName(user.firstName));
  }, [user]);

  const onStickyMentionsChange = useCallback(
    (mentions: AgentMention[]) => {
      setStickyMentions(mentions);
    },
    [setStickyMentions]
  );

  return (
    <DropzoneContainer
      description="Drag and drop your text files (txt, doc, pdf) and image files (jpg, png) here."
      title="Attach files to the conversation"
    >
      {activeConversationId ? (
        <ConversationViewer
          owner={owner}
          user={user}
          conversationId={activeConversationId}
          // TODO(2024-06-20 flav): Fix extra-rendering loop with sticky mentions.
          onStickyMentionsChange={onStickyMentionsChange}
        />
      ) : (
        <div></div>
      )}

      {!activeConversationId && (
        <div
          id="assistant-input-header"
          className="flex h-fit min-h-[20vh] w-full max-w-4xl flex-col justify-end gap-8 py-2"
        >
          <Page.Header title={greeting} />
          <Page.SectionHeader title="Start a conversation" />
        </div>
      )}

      <FixedAssistantInputBar
        owner={owner}
        onSubmit={
          activeConversationId ? handleSubmit : handleConversationCreation
        }
        stickyMentions={stickyMentions}
        conversationId={activeConversationId}
      />

      {!activeConversationId && (
        <AssistantBrowserContainer
          onAgentConfigurationClick={setInputbarMention}
          setAssistantToMention={(assistant) => {
            assistantToMention.current = assistant;
          }}
          owner={owner}
          isBuilder={isBuilder}
        />
      )}

      <ReachedLimitPopup
        isOpened={planLimitReached}
        onClose={() => setPlanLimitReached(false)}
        subscription={subscription}
        owner={owner}
        code="message_limit"
      />
    </DropzoneContainer>
  );
}
