import { dashboardClient } from "./dashboard/client.js";
import { dashboardMarkup } from "./dashboard/markup.js";
import { dashboardStyles } from "./dashboard/styles.js";

export const dashboard = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canary · QA de vos pull requests</title><style>${dashboardStyles}</style></head><body>${dashboardMarkup}<script>${dashboardClient}</script></body></html>`;
