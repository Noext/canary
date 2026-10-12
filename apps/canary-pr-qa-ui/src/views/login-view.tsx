import { type FormEvent, useState } from "react";
import { useError } from "@/app/errors";
import { useSession } from "@/app/session";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import { Field, Input, Label } from "@/components/ui/form";
import { auth } from "@/i18n";

/** `auth` carries the visible label; the accessible name spells out the target. */
const passwordToggleAria = {
  hide: "Masquer le mot de passe",
  show: "Afficher le mot de passe",
} as const;

function Logo() {
  return (
    <div className="flex items-center gap-2 font-semibold text-xl">
      <span
        aria-hidden="true"
        className="size-4 rounded-full border-2 border-primary-edge bg-primary"
      />
      Canary
    </div>
  );
}

/**
 * The whole unauthenticated screen: first-run account creation and local
 * sign-in. A successful submission updates the session, and `App` swaps the
 * screens on its own — this view never navigates.
 */
export function LoginView() {
  const { createAdmin, initialized, login, loginWithToken, setupCode } =
    useSession();
  const { clear, report } = useError();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [token, setToken] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const firstRun = !initialized;
  const missingSetupCode = firstRun && !setupCode;
  const setupCommand = `${auth.setupCommandPrefix}${window.location.origin}`;

  const submitAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clear();
    if (firstRun && password !== confirmation) {
      report(new Error(auth.passwordMismatch));
      return;
    }
    setBusy(true);
    setStatus(firstRun ? auth.creating : auth.loggingIn);
    try {
      if (firstRun) {
        await createAdmin(username, password);
      } else {
        await login(username, password);
      }
      setPassword("");
      setConfirmation("");
    } catch (failure) {
      report(failure);
    } finally {
      setStatus("");
      setBusy(false);
    }
  };

  const submitToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await loginWithToken(token);
      setToken("");
    } catch (failure) {
      report(failure);
    }
  };

  return (
    <>
      <header className="px-6 py-5 md:px-10 md:py-7" id="authHeader">
        <Logo />
      </header>
      <section
        className="mx-auto mt-4 mb-12 w-[calc(100%-2rem)] max-w-[27rem] rounded-2xl border border-border bg-card p-8 shadow-sm"
        id="login"
      >
        <p className="font-bold text-muted-foreground text-xs uppercase tracking-[0.13em]">
          {auth.accountEyebrow}
        </p>
        <h2 className="mt-5 font-semibold text-2xl" id="authTitle">
          {firstRun ? auth.firstRun.title : auth.loginTitle}
        </h2>
        <p className="mt-3 text-muted-foreground text-sm" id="authIntro">
          {firstRun ? auth.firstRun.intro : auth.loginIntro}
        </p>
        <form
          className="mt-6 grid gap-3"
          id="accountForm"
          onSubmit={submitAccount}
        >
          <Field htmlFor="username" label={auth.usernameLabel}>
            <Input
              autoComplete="username"
              id="username"
              maxLength={64}
              minLength={3}
              name="username"
              onChange={(event) => setUsername(event.target.value)}
              pattern="[A-Za-z0-9][A-Za-z0-9_.@-]{2,63}"
              placeholder={auth.usernamePlaceholder}
              required
              value={username}
            />
          </Field>
          <div>
            <Label htmlFor="password">{auth.passwordLabel}</Label>
            <div className="flex gap-2">
              <Input
                autoComplete={firstRun ? "new-password" : "current-password"}
                className="min-w-0 flex-1"
                id="password"
                maxLength={128}
                minLength={12}
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder={auth.passwordPlaceholder}
                required
                type={showPassword ? "text" : "password"}
                value={password}
              />
              <Button
                aria-label={
                  showPassword
                    ? passwordToggleAria.hide
                    : passwordToggleAria.show
                }
                className="mt-1 shrink-0"
                id="showPassword"
                onClick={() => setShowPassword((visible) => !visible)}
                variant="secondary"
              >
                {showPassword ? auth.hidePassword : auth.showPassword}
              </Button>
            </div>
          </div>
          <div hidden={!firstRun}>
            <Field htmlFor="confirmPassword" label={auth.confirmation}>
              <Input
                autoComplete="new-password"
                id="confirmPassword"
                maxLength={128}
                minLength={12}
                name="confirmPassword"
                onChange={(event) => setConfirmation(event.target.value)}
                required={firstRun}
                type="password"
                value={confirmation}
              />
            </Field>
          </div>
          <Notice hidden={!missingSetupCode} id="setupInstructions">
            <p>{auth.setupInstructions}</p>
            <code
              className="mt-2 block break-words font-mono text-xs"
              id="setupCommand"
            >
              {setupCommand}
            </code>
            <small className="mt-1 block text-muted-foreground text-xs">
              {auth.setupPrivacy}
            </small>
          </Notice>
          <Button
            disabled={busy || missingSetupCode}
            id="accountSubmit"
            type="submit"
            variant="primary"
          >
            {firstRun ? auth.createAccount : auth.login}
          </Button>
          <p
            className="text-muted-foreground text-sm empty:hidden"
            id="authStatus"
            role="status"
          >
            {status}
          </p>
        </form>
        <small className="block text-muted-foreground text-xs">
          {auth.alreadyHaveAccount}
        </small>
        <details
          className="mt-6 border-border border-t pt-4"
          id="technicalAccess"
        >
          <summary className="cursor-pointer font-medium text-sm">
            {auth.technicalSummary}
          </summary>
          <form
            className="mt-4 grid gap-2"
            id="loginForm"
            onSubmit={submitToken}
          >
            <Field htmlFor="token" label={auth.tokenLabel}>
              <Input
                autoComplete="off"
                id="token"
                onChange={(event) => setToken(event.target.value)}
                required
                type="password"
                value={token}
              />
            </Field>
            <Button type="submit" variant="secondary">
              {auth.technicalLogin}
            </Button>
          </form>
        </details>
      </section>
    </>
  );
}
