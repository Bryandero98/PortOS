// Outbound link to a primary source (a model card, a license text) as rendered
// by the disclosure surfaces. Shared by ModelDisclosure and ModelTermsGate so
// the two halves of one panel can't drift apart on link affordance.
import { ExternalLink } from 'lucide-react';

export default function FactLink({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-port-accent hover:underline break-all"
    >
      {children}
      <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
    </a>
  );
}
