/**
 * wopr-for-pi extension entry point.
 *
 * Registers all 23 wopr orchestration tools as pi-native tools and loads the
 * wopr skill into pi's context for automatic discovery.
 *
 * @module
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent"
import { registerAllWoprTools } from "./tools"

const extension: InlineExtension = {
  name: "wopr",
  factory: (pi) => {
    // Register all 23 wopr tools with the pi session
    registerAllWoprTools(pi)

    // The skill.md file at extensions/wopr-for-pi/skill.md is the companion
    // knowledge artifact. Pi loads it from the extension directory when
    // skills are enabled. In wopr's pi.ts, skills are disabled for pipeline
    // phases (noSkills: true), but when the extension is loaded directly
    // by pi (via `pi extensions install`), pi discovers and loads skill.md
    // automatically from the extension's directory.
    //
    // Note: pi's ExtensionAPI does not currently expose an addSkill() method
    // for programmatic skill injection. The skill.md file is loaded by pi's
    // resource loader when noSkills is false (the default for standalone pi).
  },
}

export default extension
