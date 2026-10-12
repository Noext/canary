import { initializeAuth } from "./auth.js";
import { initializeGithub } from "./github.js";
import { initializeModels } from "./models.js";
import { initializeNavigation } from "./navigation.js";
import { initializeOverview } from "./overview.js";
import { initializeRuns } from "./runs.js";

initializeNavigation();
initializeOverview();
initializeGithub();
initializeModels();
initializeRuns();
initializeAuth();
