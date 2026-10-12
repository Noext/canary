import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { api } from "@/api/client";
import type { runJobListSchema } from "@/api/schemas";
import { useError } from "@/app/errors";
import { useNavigation } from "@/app/navigation";
import { useSession } from "@/app/session";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/feedback";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
} from "@/components/ui/form";
import { Table, TableWrap, Th } from "@/components/ui/table";
import { runs as copy } from "@/i18n";
import {
  formatDate,
  outcomeLabel,
  shortSha,
  stateLabel,
  toneFor,
} from "@/lib/format";
import { modelFromInput, RunDetail } from "./run-detail";

type RunRow = z.infer<typeof runJobListSchema>[number];

interface Filters {
  search: string;
  status: string;
}

const emptyFilters: Filters = { search: "", status: "" };

/**
 * The history filter offers completed, cancelled and interrupted in the
 * plural, which the per-run labels above do not carry.
 */
const statusFilters: { label: string; value: string }[] = [
  { label: copy.filters.all, value: "" },
  { label: stateLabel("queued"), value: "queued" },
  { label: stateLabel("running"), value: "running" },
  { label: copy.filters.completed, value: "completed" },
  { label: copy.filters.cancelled, value: "cancelled" },
  { label: copy.filters.interrupted, value: "interrupted" },
];

const cellClass = "border-b border-border px-3 py-2 align-middle";

/**
 * The runs screen: the recorded sessions, their filters and, above them, the
 * detail of the selected run.
 */
export function RunsView() {
  const { report } = useError();
  const { canWrite } = useSession();
  const { consumeRun, openRun, requestedRun } = useNavigation();
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [rows, setRows] = useState<RunRow[]>([]);
  const [filtered, setFiltered] = useState(false);
  const [selected, setSelected] = useState<string>();

  const list = useCallback(
    async (filters: Filters) => {
      try {
        const next = await api("/runs", {
          query: { search: filters.search, status: filters.status },
        });
        setRows(next);
        setFiltered(Boolean(filters.search || filters.status));
      } catch (failure) {
        report(failure);
      }
    },
    [report]
  );

  useEffect(() => {
    void list(emptyFilters);
  }, [list]);

  // A deep link, a row click or a freshly created run all arrive as a request.
  useEffect(() => {
    if (!requestedRun) {
      return;
    }
    setSelected(requestedRun);
    consumeRun();
  }, [consumeRun, requestedRun]);

  const refresh = useCallback(() => {
    void list(applied);
  }, [applied, list]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApplied(draft);
    void list(draft);
  }

  return (
    <>
      <RunDetail
        canWrite={canWrite}
        key={selected ?? "empty"}
        onUpdate={refresh}
        runId={selected}
      />
      <Card className="mt-5">
        <CardHeader>
          <div>
            <CardTitle>{copy.historyTitle}</CardTitle>
            <CardDescription>{copy.historyIntro}</CardDescription>
          </div>
        </CardHeader>
        <form
          className="flex flex-wrap items-end gap-2"
          id="filters"
          onSubmit={applyFilters}
        >
          <Input
            aria-label={copy.filters.searchLabel}
            className="mt-0 w-auto min-w-56"
            id="search"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                search: event.target.value,
              }))
            }
            placeholder={copy.filters.search}
            value={draft.search}
          />
          <Select
            aria-label={copy.filters.statusLabel}
            className="mt-0 w-auto"
            id="status"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                status: event.target.value,
              }))
            }
            value={draft.status}
          >
            {statusFilters.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button type="submit">{copy.filters.submit}</Button>
        </form>
        <div
          className="mt-4 rounded-lg border border-border border-dashed p-6 text-center"
          hidden={rows.length > 0}
          id="historyEmpty"
        >
          <div aria-hidden="true" className="text-2xl text-faint">
            ≡
          </div>
          <h3 className="mt-1 font-semibold" id="historyEmptyTitle">
            {filtered ? copy.filteredEmptyTitle : copy.emptyTitle}
          </h3>
          <p className="text-muted-foreground text-sm" id="historyEmptyIntro">
            {filtered ? copy.filteredEmptyIntro : copy.emptyIntro}
          </p>
        </div>
        <TableWrap hidden={rows.length === 0} id="historyTable">
          <Table>
            <thead>
              <tr>
                <Th>{copy.table.pr}</Th>
                <Th>{copy.table.commit}</Th>
                <Th>{copy.table.model}</Th>
                <Th>{copy.table.status}</Th>
                <Th>{copy.table.result}</Th>
                <Th>{copy.table.created}</Th>
              </tr>
            </thead>
            <tbody id="runs">
              {rows.map((run) => (
                <tr key={run.id}>
                  <td className={cellClass}>
                    <a
                      className="font-medium underline-offset-4 hover:underline"
                      href={`#${run.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        openRun(run.id);
                      }}
                    >
                      {`${run.repo} #${run.pr}`}
                    </a>
                  </td>
                  <td className={cellClass}>
                    <code>{shortSha(run.sha)}</code>
                  </td>
                  <td className={cellClass}>
                    {modelFromInput(run.input) || copy.historicalModel}
                  </td>
                  <td className={cellClass}>
                    <Pill tone={toneFor(run.status)}>
                      {stateLabel(run.status)}
                    </Pill>
                  </td>
                  <td className={cellClass}>
                    <Pill tone={toneFor(run.outcome ?? "")}>
                      {run.outcome ? outcomeLabel(run.outcome) : "—"}
                    </Pill>
                  </td>
                  <td className={cellClass}>{formatDate(run.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>
    </>
  );
}
