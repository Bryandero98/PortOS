import { useNavigate } from 'react-router';
import TabPills from './TabPills';

/**
 * A `TabPills` bar whose tabs are ROUTES rather than local state.
 *
 * Several top-level sections are one page per tab, hosted at their own URLs, so
 * the "tab bar" is really a navigation control: selecting one navigates instead
 * of swapping state. That is what makes each tab deep-linkable and reachable
 * from ⌘K and voice — the URL is the source of truth for what is open
 * (`client/src/CLAUDE.md`).
 *
 * Each section owns its own `TABS` array (`{ id, label, to }`) and passes it in;
 * the navigation shim is the same for all of them. Sections may include a tab
 * whose `to` lives outside their route prefix (Models → Playground) — the id
 * still selects it, so the host page passes its own `activeTab`.
 *
 * Sections with more tabs than a pill bar reads well at (Models) pass
 * `mobileDropdown` — plus `mobileSelectId`, so the collapsed `<select>` gets a
 * real `<label htmlFor>` rather than only an aria-label.
 *
 * @param {{ tabs: Array<{id:string,label:string,to:string}>, activeTab: string, ariaLabel: string, mobileDropdown?: boolean, mobileSelectId?: string }} props
 */
export default function RouteTabsHeader({ tabs, activeTab, ariaLabel, mobileDropdown = false, mobileSelectId }) {
  const navigate = useNavigate();

  const handleChange = (tabId) => {
    const target = tabs.find((t) => t.id === tabId);
    if (target) navigate(target.to);
  };

  return (
    <TabPills
      tabs={tabs}
      activeTab={activeTab}
      onChange={handleChange}
      ariaLabel={ariaLabel}
      mobileDropdown={mobileDropdown}
      mobileSelectId={mobileSelectId}
      className="w-full min-w-0 shrink-0"
    />
  );
}
