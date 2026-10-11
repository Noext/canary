import { timingSafeEqual } from "node:crypto";

export function authenticTransportRequest(
  line: string,
  expectedToken: string
): boolean {
  try {
    const data: unknown = JSON.parse(line);
    if (
      !data ||
      typeof data !== "object" ||
      !("transportToken" in data) ||
      typeof data.transportToken !== "string"
    ) {
      return false;
    }
    const actual = Buffer.from(data.transportToken);
    const expected = Buffer.from(expectedToken);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
