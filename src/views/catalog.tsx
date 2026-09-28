import type { FC } from "hono/jsx";
import { BRAND } from "../brand.ts";
import type { CatalogCard, CatalogGroup } from "../present.ts";
import { ConnectorIcon, Icon } from "./ui.tsx";

export function connectHref(connectorId: string, next: string): string {
  return `/connect/${encodeURIComponent(connectorId)}?${new URLSearchParams({ next })}`;
}

const Card: FC<{ card: CatalogCard; next: string }> = ({ card, next }) => {
  const { connector, state, account } = card;
  const body = (
    <>
      <ConnectorIcon logo={connector} />
      <span class="card-text">
        <strong>{connector.name}</strong>
        <span>{state === "connected" && account ? account : connector.description}</span>
      </span>
    </>
  );
  // data-search holds the words that the search box matches.
  const search = `${connector.name} ${connector.description} ${connector.category}`.toLowerCase();
  if (state === "connected") {
    return (
      <li class="card card-on" data-search={search}>
        {body}
        <span class="card-state card-state-on" title="Connected">
          <Icon name="check" />
        </span>
      </li>
    );
  }
  if (state === "setup_needed") {
    return (
      <li class="card card-off" data-search={search} title={`${connector.name} must approve ${BRAND.name} first`}>
        {body}
        <span class="chip">Soon</span>
      </li>
    );
  }
  return (
    <li class="card" data-search={search}>
      <a class="card-link" href={connectHref(connector.id, next)} aria-label={`Add ${connector.name}`}>
        {body}
        <span class="card-state">
          <Icon name="plus" />
        </span>
      </a>
    </li>
  );
};

/** The list of all connectors. `next` is the page that the user returns to after the sign-in at the provider. */
export const CatalogGrid: FC<{ groups: CatalogGroup[]; next: string; compact?: boolean }> = ({ groups, next, compact }) => (
  <div class={`catalog${compact ? " catalog-compact" : ""}`} data-catalog>
    <div class="catalog-tools">
      <label class="search">
        <Icon name="search" />
        <input type="search" placeholder="Search connectors" aria-label="Search connectors" data-catalog-search />
      </label>
    </div>
    {groups.map((group) => (
      <section class="catalog-group" data-catalog-group>
        <h3>{group.category}</h3>
        <ul class="cards">
          {group.cards.map((card) => (
            <Card card={card} next={next} />
          ))}
        </ul>
      </section>
    ))}
    <p class="panel-empty" data-catalog-empty hidden>
      No connector matches.
    </p>
  </div>
);
