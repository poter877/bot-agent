// The learning-journey (starmap) overlay.
// Owned namespace: `journey`. Leaves are strings or `(...args) => string`;
// packs supply `{0}`, `{1}` positional placeholders, so keep argument order
// stable and comment it when >1 arg.
//
// Not keyed on purpose: hotkey chords inside hints are part of the hint string,
// glyphs (`▸`, `✦`, `└─`, `›`) stay in code, and everything the learning graph
// renderer (learning_graph_render.py) ships already rendered — legend labels,
// category names, bucket labels, summary lines, node meta — is shown verbatim.

export const journeyEn = {
  journey: {
    title: 'Journey',
    subtitle: 'learned skills & memories over time',
    closeHint: 'Esc/q close',
    error: (message: string) => `error: ${message}`,
    loading: 'assembling your learning map…',
    empty: 'No learning yet — your learned skills and memories will start mapping out here as you use Hermes.',
    noDetail: 'No additional detail recorded yet.',
    notice: {
      cannotEdit: 'cannot edit',
      noChanges: 'no changes'
    },
    confirmDelete: (label: string) => `delete ${label}? y/N`,
    slice: {
      skillsOne: (count: number) => `${count} skill`,
      skillsOther: (count: number) => `${count} skills`,
      memoriesOne: (count: number) => `${count} memory`,
      memoriesOther: (count: number) => `${count} memories`
    },
    hint: {
      item: '↑↓/jk scroll · PgUp/PgDn page · e edit · d delete · Esc/← back · q close',
      // Timeline hint segments; the component joins the applicable ones with ' · '.
      move: '↑↓/jk move',
      open: 'Enter/→ open',
      edit: 'e edit',
      delete: 'd delete',
      topBottom: 'g/G top/bottom',
      close: 'q close'
    }
  }
}
