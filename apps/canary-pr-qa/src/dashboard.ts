import client from "./dashboard/client.ts?browser";
import html from "./dashboard/index.html?raw";
import styles from "./dashboard/styles.css?raw";

export const dashboard = html;
export const dashboardAssets = new Map([
  [
    "/dashboard/assets/styles.css",
    { type: "text/css; charset=utf-8", body: styles },
  ],
  [
    "/dashboard/assets/client.js",
    { type: "text/javascript; charset=utf-8", body: client },
  ],
]);
