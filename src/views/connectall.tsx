/**
 * "Connect everything": the extension Gulpy for Chrome opens each app in a background tab,
 * where the user is already signed in, and taps Allow. The page shows the progress.
 * The script is /assets/connect-all.js; the extension is in extension/.
 */
import type { FC } from "hono/jsx";
import type { Viewer } from "../auth.ts";
import { BRAND } from "../brand.ts";
import type { Connector } from "../catalog.ts";
import { ConnectorIcon, LinkPage, Mascot, SitePage } from "./ui.tsx";

export interface ConnectAllItem {
  connector: Connector;
  /** Where the connect starts. It returns to /connect-all/done. */
  url: string;
}

const Row: FC<{ item: ConnectAllItem; auto: boolean }> = ({ item, auto }) => (
  <li class="ca-row" data-item={auto ? item.connector.id : undefined} data-url={auto ? item.url : undefined}>
    <ConnectorIcon logo={item.connector} small />
    <span class="ca-name">{item.connector.name}</span>
    {auto ? (
      <span class="ca-status" data-status>
        Waiting
      </span>
    ) : (
      <a class="btn btn-light btn-small" href={item.url.replace("/connect-all/done", "/connect-all")}>
        Connect
      </a>
    )}
  </li>
);

export const ConnectAll: FC<{ viewer: Viewer; auto: ConnectAllItem[]; tap: ConnectAllItem[]; connected: number }> = ({
  viewer,
  auto,
  tap,
  connected,
}) => (
  <SitePage title="Connect everything" viewer={viewer} current="tools" script="/assets/connect-all.js">
    <main id="main" class="site-main ca-page">
      <section class="panel ca-head">
        <h1>Connect everything</h1>
        <p class="muted">
          {BRAND.name} for Chrome opens each app you use in the background and taps Allow for you. Apps you are not
          signed in to are skipped. Remove any tool later on <a href="/">My tools</a>.
        </p>
        <p class="ca-ext" data-ext-status>
          Looking for {BRAND.name} for Chrome…
        </p>
        <div class="ca-actions">
          <button class="btn btn-primary" type="button" data-connect-all disabled>
            Connect everything ({auto.length})
          </button>
          <span class="muted" data-summary>
            {connected} connected now
          </span>
        </div>
        <div class="ca-install" data-ext-missing hidden>
          <strong>Add {BRAND.name} for Chrome first</strong>
          <ol>
            <li>Open chrome://extensions and turn on Developer mode.</li>
            <li>Select "Load unpacked" and choose the folder extension/ of the {BRAND.name} code.</li>
            <li>Reload this page.</li>
          </ol>
        </div>
      </section>
      {auto.length > 0 && (
        <section class="panel">
          <h2>Automatic</h2>
          <ul class="ca-list">
            {auto.map((item) => (
              <Row item={item} auto />
            ))}
          </ul>
        </section>
      )}
      {tap.length > 0 && (
        <section class="panel">
          <h2>One tap</h2>
          <p class="muted">Google and Microsoft ask you to confirm yourself.</p>
          <ul class="ca-list">
            {tap.map((item) => (
              <Row item={item} auto={false} />
            ))}
          </ul>
        </section>
      )}
    </main>
  </SitePage>
);

/** Where a background connect ends. The extension closes this tab. */
export const ConnectAllDone: FC = () => (
  <LinkPage title="Connected">
    <div class="done">
      <Mascot size="large" />
      <h1>Connected</h1>
      <p class="muted">You can close this tab.</p>
    </div>
  </LinkPage>
);
