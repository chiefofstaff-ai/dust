import type { AfterCallbackPageRoute, LoginOptions } from "@auth0/nextjs-auth0";
import {
  CallbackHandlerError,
  handleAuth,
  handleCallback,
  handleLogin,
  handleLogout,
  IdentityProviderError,
} from "@auth0/nextjs-auth0";
import type { NextApiRequest, NextApiResponse } from "next";

import { getRegionForUserSession, setRegionForUser } from "@app/lib/api/auth0";
import config from "@app/lib/api/config";
import type { RegionType } from "@app/lib/api/regions/config";
import { config as multiRegionsConfig } from "@app/lib/api/regions/config";
import { checkUserRegionAffinity } from "@app/lib/api/regions/lookup";
import { getRegionFromRequest } from "@app/lib/api/regions/utils";
import { isEmailValid } from "@app/lib/utils";
import logger from "@app/logger/logger";
import { statsDClient } from "@app/logger/withlogging";

const isString = (value: unknown): value is string => typeof value === "string";

const afterCallback: AfterCallbackPageRoute = async (
  req,
  res,
  session,
  state
) => {
  const currentRegion = multiRegionsConfig.getCurrentRegion();

  let targetRegion: RegionType | null = null;

  // If user has a region, redirect to the region page.
  const userSessionRegion = getRegionForUserSession(session);
  if (userSessionRegion) {
    targetRegion = userSessionRegion;
  } else {
    // For new users or users without region, perform lookup.
    const regionWithAffinityRes = await checkUserRegionAffinity({
      email: session.user.email,
      email_verified: session.user.email_verified,
    });

    // Throw error it will be caught by the login callback wrapper.
    if (regionWithAffinityRes.isErr()) {
      throw regionWithAffinityRes.error;
    }

    if (regionWithAffinityRes.value.hasAffinity) {
      targetRegion = regionWithAffinityRes.value.region;
    } else {
      // No region affinity found - keep user in their originally accessed region (from URL).
      targetRegion = getRegionFromRequest(req);
    }

    // Update Auth0 metadata only once when not set.
    await setRegionForUser(session, targetRegion);

    // TODO: Consider updating current session with new metadata.
  }

  // If wrong region, redirect to login with prompt=none on correct domain.
  if (targetRegion !== currentRegion) {
    const targetRegionInfo = multiRegionsConfig.getOtherRegionInfo();

    const params = new URLSearchParams();

    // Add the silent auth params.
    params.set("prompt", "none");

    // Extract just the path from the full returnTo URL.
    if (state?.returnTo) {
      try {
        const url = new URL(state.returnTo);
        params.set("returnTo", url.pathname + url.search);
      } catch {
        // Fallback if URL parsing fails.
        params.set("returnTo", "/");
      }
    }

    params.set("returnTo", "/api/login");

    // We redirect before returning the session, which prevents nextjs-auth0 from setting a session
    // cookie on this domain. The user will get their session cookie only after silent auth
    // completes on their correct region domain.
    res.writeHead(302, {
      Location: `${targetRegionInfo.url}/api/auth/login?${params.toString()}`,
    });
    res.end();
    return;
  }

  return session;
};

export default handleAuth({
  login: handleLogin((req) => {
    const { connection, screen_hint, login_hint } =
      "query" in req
        ? req.query
        : {
            connection: undefined,
            login_hint: undefined,
            screen_hint: undefined,
          };

    const defaultAuthorizationParams: Partial<
      LoginOptions["authorizationParams"]
    > = {
      scope: "openid profile email",
    };

    // Set the Auth0 connection based on the provided connection param, redirecting the user to the correct screen.
    if (isString(connection)) {
      defaultAuthorizationParams.connection = connection;
    }

    if (isString(screen_hint) && screen_hint === "signup") {
      defaultAuthorizationParams.screen_hint = screen_hint;
    }

    if (isString(login_hint) && isEmailValid(login_hint)) {
      defaultAuthorizationParams.login_hint = login_hint;
    }

    return {
      authorizationParams: defaultAuthorizationParams,
      returnTo: "/api/login", // Note from seb, I think this is not used
    };
  }),
  callback: async (req: NextApiRequest, res: NextApiResponse) => {
    try {
      await handleCallback(req, res, { afterCallback });
    } catch (error) {
      let reason: string | null = null;

      if (error instanceof CallbackHandlerError) {
        if (error.cause instanceof IdentityProviderError) {
          const { error: err, errorDescription } = error.cause;
          if (err === "access_denied") {
            reason = errorDescription ?? err;
          } else {
            reason = err ?? null;
          }
        }

        logger.info(
          { cause: error.cause?.message, reason },
          "login error in auth0 callback"
        );

        statsDClient.increment("login.callback.error", 1, [
          `error:${error.cause?.message}`,
        ]);

        return res.redirect(`/login-error?reason=${reason}`);
      }

      statsDClient.increment("login.callback.error", 1, ["error:unknow"]);

      return res.redirect("/login-error");
    }
  },
  logout: handleLogout((req) => {
    return {
      returnTo:
        "query" in req
          ? (req.query.returnTo as string)
          : config.getClientFacingUrl(),
    };
  }),
});
