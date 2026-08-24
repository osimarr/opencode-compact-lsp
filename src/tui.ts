import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { pluginId } from "./plugin-id"

export default {
  id: pluginId(import.meta.url),
  tui: async (api) => {
    try {
      const { createStatsSidebarSlot } = await import("./tui/stats-sidebar")
      const { clearReaderState } = await import("./tui/stats-reader")
      const slot = await createStatsSidebarSlot(api)
      api.slots.register(slot)
      api.lifecycle.onDispose(() => {
        clearReaderState()
      })
    } catch {
      // Host must supply solid-js / @opentui/solid. Never fail TUI boot.
    }
  },
} satisfies TuiPluginModule
