"use client";

import { track } from "@vercel/analytics";
import { Input } from "@vercel/geistdocs/components/input";
import { InputGroup, InputGroupAddon } from "@vercel/geistdocs/components/input-group";
import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyticsEvents,
  getCountBucket,
  getQueryLengthBucket,
  normalizeSearchQuery,
} from "@/lib/analytics/events";
import {
  type Integration,
  type IntegrationType,
  integrationDomainOrder,
  recommendedIntegrationSlugs,
} from "@/lib/integrations/data";
import { cn } from "@/lib/utils";
import { IntegrationCard } from "./integration-card";

export type GalleryFilter = "all" | IntegrationType | "memory";

const FILTERS: { value: GalleryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "channel", label: "Channels" },
  { value: "connection", label: "Connections" },
  { value: "extension", label: "Extensions" },
  { value: "memory", label: "Memory" },
  { value: "instrumentation", label: "Observability" },
];

const FILTER_DESCRIPTIONS: Record<Exclude<GalleryFilter, "all">, string> = {
  channel:
    "Channels are the surfaces where users talk to your agent: Slack, Discord, web chat, and more.",
  connection:
    "Connections are the tools your agent calls during a run: services reached over MCP or OpenAPI.",
  extension: "Extensions are packages that add reusable tools, skills, connections, and hooks.",
  memory: "Memory providers store and recall context across sessions through eve-managed scopes.",
  instrumentation:
    "Observability providers are OpenTelemetry backends that receive your agent's traces: every model call, tool execution, and turn.",
};

const domainHeadingId = (domain: string): string =>
  `domain-${domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")}`;

interface GalleryProps {
  filter: GalleryFilter;
  integrations: Integration[];
}

export const Gallery = ({ filter, integrations }: GalleryProps) => {
  const [query, setQuery] = useState("");
  const lastTrackedSearch = useRef("");

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return integrations.filter((integration) => {
      if (filter === "memory" && !integration.keywords?.includes("memory")) {
        return false;
      }
      if (filter !== "all" && filter !== "memory" && integration.type !== filter) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      const haystack = [integration.name, integration.tagline, ...(integration.keywords ?? [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [integrations, filter, query]);

  const normalizedQuery = query.trim().toLowerCase();
  const showRecommendations = filter === "all" && normalizedQuery.length === 0;
  const recommendedSlugSet = useMemo(() => new Set<string>(recommendedIntegrationSlugs), []);
  const recommendations = useMemo(
    () =>
      recommendedIntegrationSlugs.flatMap((slug) => {
        const integration = integrations.find((candidate) => candidate.slug === slug);
        return integration ? [integration] : [];
      }),
    [integrations],
  );
  const groupedResults = useMemo(
    () =>
      integrationDomainOrder.flatMap((domain) => {
        const domainIntegrations = results.filter(
          (integration) =>
            integration.domain === domain &&
            (!showRecommendations || !recommendedSlugSet.has(integration.slug)),
        );
        return domainIntegrations.length > 0 ? [{ domain, integrations: domainIntegrations }] : [];
      }),
    [recommendedSlugSet, results, showRecommendations],
  );

  useEffect(() => {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) {
      lastTrackedSearch.current = "";
      return;
    }

    const searchKey = `${filter}:${normalizedQuery}`;
    if (searchKey === lastTrackedSearch.current) return;

    const timer = setTimeout(() => {
      track(analyticsEvents.integrationsSearched, {
        filter,
        query: normalizedQuery,
        query_length: getQueryLengthBucket(normalizedQuery),
        results: getCountBucket(results.length),
      });
      lastTrackedSearch.current = searchKey;
    }, 500);

    return () => clearTimeout(timer);
  }, [filter, query, results.length]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-3 min-[1024px]:flex-row min-[1024px]:items-center min-[1024px]:justify-between">
        <div
          aria-label="Integration filter"
          className="flex w-full gap-0.5 overflow-x-auto rounded-md border bg-background-100 p-1 [scrollbar-width:none] min-[1024px]:w-fit [&::-webkit-scrollbar]:hidden"
          role="group"
        >
          {FILTERS.map(({ value, label }) => (
            <Link
              aria-current={filter === value ? "page" : undefined}
              className={cn(
                "shrink-0 whitespace-nowrap rounded px-3 py-1 font-medium text-sm no-underline transition-colors",
                filter === value
                  ? "bg-gray-100 text-gray-1000"
                  : "text-gray-900 hover:bg-gray-100/40 hover:text-gray-1000",
              )}
              href={value === "all" ? "/integrations" : `/integrations?filter=${value}`}
              key={value}
              onClick={() => track(analyticsEvents.integrationFilterSelected, { filter: value })}
              prefetch={true}
              scroll={false}
            >
              {label}
            </Link>
          ))}
        </div>
        <InputGroup className="h-9 w-full bg-background min-[1024px]:w-64">
          <InputGroupAddon>
            <SearchIcon className="size-4 text-gray-700" />
          </InputGroupAddon>
          <Input
            aria-label="Search integrations"
            className="h-full border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search integrations"
            value={query}
          />
        </InputGroup>
      </div>

      {filter !== "all" && <p className="text-gray-800 text-sm">{FILTER_DESCRIPTIONS[filter]}</p>}

      {results.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-10">
          {showRecommendations ? (
            <section aria-labelledby="recommended-integrations">
              <div className="mb-4 flex flex-col gap-1">
                <h2 className="text-gray-1000 text-heading-24" id="recommended-integrations">
                  Recommended
                </h2>
                <p className="text-gray-800 text-sm">
                  Curated from the integrations featured across official eve templates.
                </p>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-4 min-[1024px]:grid-cols-2 min-[1200px]:grid-cols-3">
                {recommendations.map((integration) => (
                  <IntegrationCard
                    integration={integration}
                    key={integration.slug}
                    onSelect={() =>
                      track(analyticsEvents.integrationOpened, {
                        filter,
                        integration: integration.slug,
                        search: false,
                      })
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          {groupedResults.map(({ domain, integrations: domainIntegrations }) => {
            const headingId = domainHeadingId(domain);
            return (
              <section aria-labelledby={headingId} key={domain}>
                <div className="mb-4 flex items-baseline gap-2">
                  <h2 className="text-gray-1000 text-heading-20" id={headingId}>
                    {domain}
                  </h2>
                  <span className="text-gray-700 text-sm">{domainIntegrations.length}</span>
                </div>
                <div className="grid min-w-0 grid-cols-1 gap-4 min-[1024px]:grid-cols-2 min-[1200px]:grid-cols-3">
                  {domainIntegrations.map((integration) => (
                    <IntegrationCard
                      integration={integration}
                      key={integration.slug}
                      onSelect={() =>
                        track(analyticsEvents.integrationOpened, {
                          filter,
                          integration: integration.slug,
                          search: query.trim().length > 0,
                        })
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed py-16 text-center">
          <p className="font-medium text-gray-1000">No integrations found</p>
          <p className="text-gray-800 text-sm">Try a different search or filter.</p>
        </div>
      )}
    </div>
  );
};
