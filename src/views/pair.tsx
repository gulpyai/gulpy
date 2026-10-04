import type { FC } from "hono/jsx";
import { agentLogo } from "../logos.ts";
import type { App } from "../store.ts";
import { Avatar, Mascot } from "./ui.tsx";

/** The app on the left, Gulpy on the right, and a line of dots that moves between them. */
export const Pair: FC<{ app: Pick<App, "name" | "redirectUris"> }> = ({ app }) => (
  <div class="pair">
    <Avatar label={app.name} image={agentLogo(app.redirectUris)} large />
    <span class="pair-dots">
      <i />
      <i />
      <i />
    </span>
    <Mascot size="large" />
  </div>
);

export const Disclosure: FC<{ name: string }> = ({ name }) => (
  <p class="disclosure">
    The data of the tools that you select, for example email or events, goes to {name}. A different company operates{" "}
    {name}, with its own privacy policy. Remove access at any time on My tools.{" "}
    <a href="/terms" target="_blank">
      Terms
    </a>{" "}
    ·{" "}
    <a href="/privacy" target="_blank">
      Privacy
    </a>
  </p>
);
