import { type ReactNode, useState } from "react";
import {
  apiKeyCreatedSchema,
  apiKeyRevokedSchema,
  apiKeySecretSchema,
} from "@/api/api-keys";
import { api, errorText } from "@/api/client";
import type { ApiKeyCreated, ApiKeyRow } from "@/api/contracts";
import { Button } from "@/components/ui/button";
import { Notice, Pill } from "@/components/ui/feedback";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@/components/ui/form";
import { common, settings } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { formatDate } from "@/lib/format";
import { createStore, type Readable, type Store, useStore } from "@/lib/store";

interface ApiKeysState {
  /** The key just created: its clear token is shown here and nowhere else. */
  created?: ApiKeyCreated;
  creating: boolean;
  error?: string;
  keys: ApiKeyRow[];
  loading: boolean;
  notice?: string;
  /** Row whose copy or revocation is in flight: its buttons report the wait. */
  pending?: string;
}

interface ApiKeysStore extends Readable<ApiKeysState> {
  copy(key: ApiKeyRow): Promise<void>;
  /** Resolves `true` once the key exists, so a refused name keeps its draft. */
  create(name: string): Promise<boolean>;
  revoke(key: ApiKeyRow): Promise<void>;
}

async function loadKeys(store: Store<ApiKeysState>) {
  try {
    const keys = await api("/dashboard/api-keys");
    store.set((current) => ({
      ...current,
      error: undefined,
      keys,
      loading: false,
    }));
  } catch (failure) {
    // An empty list would read as "this instance has no key" and invite a
    // duplicate: the failure stays, and the empty state hides behind it.
    store.set((current) => ({
      ...current,
      error: errorText(failure),
      loading: false,
    }));
  }
}

async function createKey(
  store: Store<ApiKeysState>,
  name: string
): Promise<boolean> {
  store.set((current) => ({
    ...current,
    creating: true,
    error: undefined,
    notice: undefined,
  }));
  try {
    const created = await api("/dashboard/api-keys", {
      body: { name },
      method: "POST",
      schema: apiKeyCreatedSchema,
    });
    store.set((current) => ({
      ...current,
      created,
      creating: false,
      // A new key is live and the newest one: it belongs at the top, where the
      // server keeps it too.
      keys: [created, ...current.keys],
      notice: settings.apiKeys.created(created.name),
    }));
    return true;
  } catch (failure) {
    store.set((current) => ({
      ...current,
      creating: false,
      error: errorText(failure),
    }));
    return false;
  }
}

async function copySecret(
  store: Store<ApiKeysState>,
  key: ApiKeyRow
): Promise<void> {
  store.set((current) => ({
    ...current,
    error: undefined,
    notice: undefined,
    pending: key.id,
  }));
  try {
    const secret = await api(
      `/dashboard/api-keys/${encodeURIComponent(key.id)}/secret`,
      { method: "POST", schema: apiKeySecretSchema }
    );
    // The token goes to the clipboard and is dropped: the row keeps showing its
    // prefix, so nothing but the receipt ever reaches the screen.
    const copied = await copyText(secret.token);
    store.set((current) => ({
      ...current,
      pending: undefined,
      ...(copied
        ? { notice: settings.apiKeys.receipt(key.name) }
        : { error: settings.apiKeys.copyFailed }),
    }));
  } catch (failure) {
    store.set((current) => ({
      ...current,
      error: errorText(failure),
      pending: undefined,
    }));
  }
}

async function revokeKey(
  store: Store<ApiKeysState>,
  key: ApiKeyRow
): Promise<void> {
  store.set((current) => ({
    ...current,
    error: undefined,
    notice: undefined,
    pending: key.id,
  }));
  try {
    const revoked = await api(
      `/dashboard/api-keys/${encodeURIComponent(key.id)}`,
      { method: "DELETE", schema: apiKeyRevokedSchema }
    );
    store.set((current) => ({
      ...current,
      // The row stays visible with the date the server recorded: the operator
      // still sees which key was closed, and what it was.
      keys: current.keys.map((row) =>
        row.id === revoked.id ? { ...row, revokedAt: revoked.revokedAt } : row
      ),
      notice: settings.apiKeys.revokeDone(key.name),
      pending: undefined,
    }));
  } catch (failure) {
    store.set((current) => ({
      ...current,
      error: errorText(failure),
      pending: undefined,
    }));
  }
}

/**
 * The API keys of this instance, administrator only.
 *
 * The list loads from the `start` callback of the store — the subscription
 * React performs on mount — because the request is started by the screen being
 * shown, not by an effect reacting to a state change. Writes update the rows in
 * place from the answer they return, so no reload can disagree with them.
 */
function createApiKeysStore(): ApiKeysStore {
  const state = createStore<ApiKeysState>(
    { creating: false, keys: [], loading: true },
    (store) => void loadKeys(store)
  );

  return {
    copy: (key) => copySecret(state, key),
    create: (name) => createKey(state, name),
    getSnapshot: state.getSnapshot,
    revoke: (key) => revokeKey(state, key),
    subscribe: state.subscribe,
  };
}

/**
 * The receipt of a copy, and nothing before it: a receipt belongs to the token
 * it copied, so a newer key is back to silence.
 */
function copyReceipt(
  copied: { ok: boolean; token: string } | undefined,
  name: string,
  token: string | undefined
): string {
  if (!(copied && token) || copied.token !== token) {
    return "";
  }
  return copied.ok
    ? settings.apiKeys.receipt(name)
    : settings.apiKeys.copyFailed;
}

/** What a row says about its key: its last use, or the date it was closed. */
function keyMeta(key: ApiKeyRow): string {
  if (key.revokedAt) {
    return settings.apiKeys.revokedAt(formatDate(key.revokedAt));
  }
  return key.lastUsedAt
    ? settings.apiKeys.lastUsed(formatDate(key.lastUsedAt))
    : settings.apiKeys.lastUsedNever;
}

function ApiKeyRowItem({
  keyRow,
  pending,
  onCopy,
  onRevoke,
}: {
  keyRow: ApiKeyRow;
  pending?: string;
  onCopy(key: ApiKeyRow): void;
  onRevoke(key: ApiKeyRow): void;
}): ReactNode {
  const revoked = Boolean(keyRow.revokedAt);
  const busy = pending === keyRow.id;

  return (
    <li
      className="rounded-lg border border-border px-3 py-2"
      data-revoked={revoked}
      id={`apiKeyRow-${keyRow.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{keyRow.name}</span>
          <code className="text-muted-foreground text-xs">{keyRow.prefix}</code>
          {revoked ? (
            <Pill id={`apiKeyRevoked-${keyRow.id}`} tone="failed">
              {settings.apiKeys.revoked}
            </Pill>
          ) : null}
        </span>
        {/*
          A revoked key keeps its row and loses its actions: the token cannot be
          read back and there is nothing left to close.
        */}
        {revoked ? null : (
          <span className="flex flex-wrap items-center gap-2">
            <Button
              disabled={busy}
              id={`apiKeyCopy-${keyRow.id}`}
              onClick={() => onCopy(keyRow)}
              size="sm"
              variant="quiet"
            >
              {settings.apiKeys.copy}
            </Button>
            <Button
              disabled={busy}
              id={`apiKeyRevoke-${keyRow.id}`}
              onClick={() => onRevoke(keyRow)}
              size="sm"
              variant="danger"
            >
              {busy ? settings.apiKeys.revoking : settings.apiKeys.revoke}
            </Button>
          </span>
        )}
      </div>
      <p className="mt-1 text-muted-foreground text-xs">{keyMeta(keyRow)}</p>
      {/*
        The scope is per key: an operator who changes the repository selection
        later needs to see which key still reads what, or revoke the wrong one.
      */}
      <p
        className="mt-1 text-muted-foreground text-xs"
        id={`apiKeyRepos-${keyRow.id}`}
      >
        {keyRow.repos.length
          ? settings.apiKeys.repos(keyRow.repos.join(", "))
          : settings.apiKeys.reposNone}
      </p>
    </li>
  );
}

export function ApiKeysSettings(): ReactNode {
  // The store belongs to this card: mounting the screen starts the list, and no
  // other view shares the state of a request it does not own.
  const [store] = useState(() => createApiKeysStore());
  const { created, creating, error, keys, loading, notice, pending } =
    useStore(store);
  const [name, setName] = useState("");
  // The receipt of the copy belongs to the token it copied: a new key always
  // brings a new token, so the previous receipt never follows it.
  const [copied, setCopied] = useState<{ ok: boolean; token: string }>();
  const draft = name.trim();

  const submit = async () => {
    // The first list is still on its way: creating now would let its answer
    // replace the new key with a list that does not carry it yet.
    if (loading || creating || !draft) {
      return;
    }
    if (await store.create(draft)) {
      setName("");
    }
  };

  const copyToken = async (token: string) => {
    setCopied({ ok: await copyText(token), token });
  };

  return (
    <Card id="apiKeysSettings">
      <CardHeader>
        <CardTitle>{settings.apiKeys.title}</CardTitle>
      </CardHeader>
      <CardDescription>{settings.apiKeys.intro}</CardDescription>
      <p className="mt-2 text-sm" id="apiKeyScope">
        {settings.apiKeys.readOnly}
      </p>

      <div className="mt-4 border-border border-t pt-4">
        <p className="font-medium text-sm">{settings.apiKeys.createTitle}</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <Label htmlFor="apiKeyName">{settings.apiKeys.nameLabel}</Label>
            <Input
              disabled={loading}
              id="apiKeyName"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={settings.apiKeys.namePlaceholder}
              value={name}
            />
          </div>
          <Button
            disabled={creating || loading || !draft}
            id="apiKeyCreate"
            onClick={() => void submit()}
            variant="primary"
          >
            {creating ? settings.apiKeys.creating : settings.apiKeys.create}
          </Button>
        </div>
      </div>

      {/*
        The clear token is shown once, right here. The block stays in the
        document, hidden until a key exists, so its ids and its warning do not
        come and go with the last creation.
      */}
      <div className="mt-4" hidden={!created} id="apiKeyTokenBlock">
        <p className="font-medium text-sm">{settings.apiKeys.tokenTitle}</p>
        <code
          className="mt-1 block break-all rounded-md border border-border bg-well p-2 text-xs"
          id="apiKeyToken"
        >
          {created?.token ?? ""}
        </code>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button
            disabled={!created}
            id="apiKeyTokenCopy"
            onClick={() => {
              const token = created?.token;
              if (token) {
                void copyToken(token);
              }
            }}
            size="sm"
          >
            {settings.apiKeys.copy}
          </Button>
          {/* The token is already on screen: the copy only owes a receipt. */}
          <span
            className="text-muted-foreground text-xs"
            id="apiKeyTokenReceipt"
            role="status"
          >
            {created ? copyReceipt(copied, created.name, created.token) : ""}
          </span>
        </div>
        <Notice className="mt-2" id="apiKeyTokenWarning" tone="warning">
          {settings.apiKeys.tokenWarning}
        </Notice>
      </div>

      <p
        className="mt-4 border-border border-t pt-4 font-medium text-sm"
        id="apiKeyListTitle"
      >
        {settings.apiKeys.listTitle}
      </p>
      <p
        className="mt-1 text-muted-foreground text-sm"
        hidden={!loading}
        role="status"
      >
        {common.loading}
      </p>
      <p
        className="mt-1 text-muted-foreground text-sm"
        hidden={loading || keys.length > 0 || Boolean(error)}
        id="apiKeyEmpty"
      >
        {settings.apiKeys.empty}
      </p>
      <ul
        className="mt-2 space-y-2"
        hidden={loading || keys.length === 0}
        id="apiKeyList"
      >
        {keys.map((keyRow) => (
          <ApiKeyRowItem
            key={keyRow.id}
            keyRow={keyRow}
            onCopy={(key) => void store.copy(key)}
            onRevoke={(key) => void store.revoke(key)}
            pending={pending}
          />
        ))}
      </ul>
      <Notice className="mt-3 empty:hidden" id="apiKeyNotice" role="status">
        {notice ?? ""}
      </Notice>
      <Notice
        className="mt-3 empty:hidden"
        id="apiKeyError"
        role="alert"
        tone="error"
      >
        {error ?? ""}
      </Notice>
    </Card>
  );
}
