import { Network } from 'lucide-react';
import Pill from '../ui/Pill';
import { formatCompactCountOrDash as formatNumber, formatUsd, timeAgo } from '../../utils/formatters';

/**
 * Per-instance AI usage across the federation, for the same report window the
 * rest of the page is showing.
 *
 * Renders nothing below two instances: a single-machine install has nothing to
 * compare against, and a one-row "fleet" is noise rather than information.
 *
 * A peer row is only as fresh as the last sync cycle, so each states when its
 * digest was captured rather than implying it is live.
 */
export default function FleetUsageCard({ fleet }) {
  const rows = fleet?.instances || [];
  if (rows.length < 2) return null;

  const label = (row) => (row.self
    ? <Pill tone="context" size="xs" className="ml-2">This machine</Pill>
    : row.capturedAt && (
      <span className="ml-2 text-[10px] text-gray-500" title={row.capturedAt}>
        synced {timeAgo(row.capturedAt)}
      </span>
    ));

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2">
        <div>
          <h3 className="text-sm font-medium text-gray-400 flex items-center gap-1.5">
            <Network size={15} className="text-port-accent" />
            Across Instances
          </h3>
          <p className="text-[10px] sm:text-xs text-gray-500 mt-0.5">
            Every federated instance&rsquo;s usage over this period, priced the same way.
          </p>
        </div>
        <div className="text-left sm:text-right">
          <div className="text-xl font-bold text-port-success">{formatUsd(fleet.totals?.estimatedCost)}</div>
          <div className="text-[10px] sm:text-xs text-gray-500">{rows.length} instances combined</div>
        </div>
      </div>

      {/* Mobile view (< sm): card list, so the numbers stay readable without a
          horizontal scroll — same pairing the cost report uses. */}
      <div className="block sm:hidden space-y-2">
        {rows.map((row) => (
          <div key={row.instanceId} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center min-w-0">
                <span className="font-medium text-white text-sm truncate">{row.name}</span>
                {label(row)}
              </div>
              <span className="text-sm font-semibold text-port-success shrink-0">{formatUsd(row.totals?.estimatedCost)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs bg-port-card/50 p-2 rounded border border-port-border/50">
              <div>
                <span className="text-gray-500 block text-[10px]">Sessions</span>
                <span className="text-white font-medium">{formatNumber(row.totals?.sessions)}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">Messages</span>
                <span className="text-white font-medium">{formatNumber(row.totals?.messages)}</span>
              </div>
              <div className="col-span-2">
                <span className="text-gray-500 block text-[10px]">Tokens (In / Out)</span>
                <span className="text-white font-medium">
                  {formatNumber(row.totals?.tokensIn)} / {formatNumber(row.totals?.tokensOut)}
                </span>
              </div>
            </div>
          </div>
        ))}
        <div className="bg-port-bg border border-port-border rounded-lg p-3 flex items-center justify-between text-xs font-semibold text-white">
          <span>Fleet total</span>
          <span className="text-port-success text-sm">{formatUsd(fleet.totals?.estimatedCost)}</span>
        </div>
      </div>

      {/* Desktop view (>= sm): table layout */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm min-w-[520px]">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-port-border">
              <th className="py-2 pr-2 font-medium">Instance</th>
              <th className="py-2 px-2 font-medium text-right">Sessions</th>
              <th className="py-2 px-2 font-medium text-right">Messages</th>
              <th className="py-2 px-2 font-medium text-right">Tokens In</th>
              <th className="py-2 px-2 font-medium text-right">Tokens Out</th>
              <th className="py-2 pl-2 font-medium text-right">Est. API Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.instanceId} className="border-t border-port-border text-white">
                <td className="py-2 pr-2">
                  <span className="font-medium truncate">{row.name}</span>
                  {label(row)}
                </td>
                <td className="py-2 px-2 text-right">{formatNumber(row.totals?.sessions)}</td>
                <td className="py-2 px-2 text-right">{formatNumber(row.totals?.messages)}</td>
                <td className="py-2 px-2 text-right">{formatNumber(row.totals?.tokensIn)}</td>
                <td className="py-2 px-2 text-right">{formatNumber(row.totals?.tokensOut)}</td>
                <td className="py-2 pl-2 text-right text-port-success">{formatUsd(row.totals?.estimatedCost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-port-border font-semibold text-white">
              <td className="py-2 pr-2">Fleet total</td>
              <td className="py-2 px-2 text-right">{formatNumber(fleet.totals?.sessions)}</td>
              <td className="py-2 px-2 text-right">{formatNumber(fleet.totals?.messages)}</td>
              <td className="py-2 px-2 text-right">{formatNumber(fleet.totals?.tokensIn)}</td>
              <td className="py-2 px-2 text-right">{formatNumber(fleet.totals?.tokensOut)}</td>
              <td className="py-2 pl-2 text-right text-port-success">{formatUsd(fleet.totals?.estimatedCost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
