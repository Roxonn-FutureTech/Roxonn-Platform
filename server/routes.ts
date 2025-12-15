import { Express } from "express";
import { registerModularRoutes } from "./routes/index";

export async function registerRoutes(app: Express) {
  registerModularRoutes(app);
}
