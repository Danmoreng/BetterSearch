import { ensureService, baseUrl } from "./service.js";
await ensureService();
console.log(`BetterSearch: ${baseUrl}`);
