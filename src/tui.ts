import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { pluginId } from "./plugin-id"

export default {
  id: pluginId(import.meta.url),
  tui: async () => {},
} satisfies TuiPluginModule
