import RouteTabsHeader from '../ui/RouteTabsHeader';

// Shared sub-nav for the top-level Models section.
//
// Model management used to be one long Settings tab: memory residency, measured
// assessments, backend install/switch, the llama.cpp launcher, and the install
// catalog all stacked on `/settings/local-llm`. Splitting them across their own
// section gives each a URL you can land on (and reach from ⌘K / voice) instead
// of a scroll position on a page about something else.
//
// Playground keeps its own `/local-llm/playground` path — it predates this
// section and the path is in ⌘K history — but it renders this header too, so
// selecting it does not strand the user outside the tab bar.
//
// Keep this list alphabetical by label, matching the sidebar convention.
export const TABS = [
  { id: 'llms', label: 'LLMs', to: '/models/llms' },
  { id: 'performance', label: 'Performance', to: '/models/performance' },
  { id: 'playground', label: 'Playground', to: '/local-llm/playground' },
  { id: 'status', label: 'Status', to: '/models/status' },
];

export default function ModelsTabsHeader({ activeTab }) {
  return <RouteTabsHeader tabs={TABS} activeTab={activeTab} ariaLabel="Models sections" />;
}
