import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { errorText } from "@/api/client";

interface ErrorContextValue {
  clear(): void;
  message: string;
  report(failure: unknown): void;
}

const ErrorContext = createContext<ErrorContextValue | undefined>(undefined);

/**
 * The single alert surface of the dashboard: `#error` stays visible above both
 * the login screen and the application shell, exactly like the legacy markup.
 */
export function ErrorProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const report = useCallback((failure: unknown) => {
    setMessage(errorText(failure));
  }, []);
  const clear = useCallback(() => setMessage(""), []);
  const value = useMemo(
    () => ({ clear, message, report }),
    [clear, message, report]
  );
  return (
    <ErrorContext.Provider value={value}>{children}</ErrorContext.Provider>
  );
}

export function useError(): ErrorContextValue {
  const value = useContext(ErrorContext);
  if (!value) {
    throw new Error("useError must be used inside ErrorProvider");
  }
  return value;
}

export function ErrorAlert() {
  const { message } = useError();
  return (
    <p
      className="mx-auto mt-4 max-w-3xl px-4 text-on-fail text-sm empty:hidden"
      id="error"
      role="alert"
    >
      {message}
    </p>
  );
}
