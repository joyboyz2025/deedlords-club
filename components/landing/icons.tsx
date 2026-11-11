// The landing page's small drawn icons: one stroke weight, one voice.

type Props = { size?: number; className?: string };
const svg = (size: number, className: string | undefined, children: React.ReactNode, stroke = true) => (
  <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill={stroke ? "none" : "currentColor"} stroke={stroke ? "currentColor" : "none"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Plane = ({ size = 22, className }: Props) => svg(size, className, <path d="M21.500 3.200c-1-.9-2.500-.700-3.500.300L14.300 7.200 4.600 4.700 3 6.300l7.600 4.500-3.300 3.400-3-.5L3 15l4 2 2 4 1.300-1.300-.5-3 3.400-3.300 4.500 7.600 1.600-1.600-2.500-9.700 3.700-3.700c1-1 1.200-2.500.300-3.500Z" />, false);
export const Clock = ({ size = 18, className }: Props) => svg(size, className, <><circle cx="12" cy="12" r="8.500" /><path d="M12 7.500V12l3 2" /></>);
export const Arrow = ({ size = 20, className }: Props) => svg(size, className, <path d="M4 12h15M13 6l6 6-6 6" />);
export const Chain = ({ size = 20, className }: Props) => svg(size, className, <path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1" />);
export const Out = ({ size = 14, className }: Props) => svg(size, className, <path d="M9 5h10v10M19 5 6 18" />);
export const Die = ({ size = 30, className }: Props) => (
  <svg className={className} viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <path d="M16 3 28 9.500v13L16 29 4 22.500v-13L16 3Z" fill="#f6ecd2" stroke="#2a1208" strokeWidth="1.600" strokeLinejoin="round" />
    <path d="M4 9.500 16 16l12-6.500M16 16v13" fill="none" stroke="#2a1208" strokeWidth="1.600" strokeLinejoin="round" />
    <g fill="#2a1208">
      <ellipse cx="16" cy="9.500" rx="1.700" ry="1.100" />
      <circle cx="8" cy="15.500" r="1.200" />
      <circle cx="12" cy="22.500" r="1.200" />
      <circle cx="20.500" cy="17.500" r="1.200" />
      <circle cx="23.500" cy="21" r="1.200" />
    </g>
  </svg>
);
