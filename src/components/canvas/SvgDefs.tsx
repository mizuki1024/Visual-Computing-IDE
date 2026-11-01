/* SVG の定義。gen_physical.py の DEFS を写したもの（地球関連は使わないため除いた）。 */
export default function SvgDefs() {
  return (
    <defs>
      <linearGradient id="gPlinth" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="rgba(157,147,224,.16)" />
        <stop offset="1" stopColor="rgba(120,150,200,.05)" />
      </linearGradient>
      <linearGradient id="gGlass" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0" stopColor="rgba(140,132,210,.26)" />
        <stop offset="55%" stopColor="rgba(60,66,110,.20)" />
        <stop offset="100%" stopColor="rgba(20,24,42,.34)" />
      </linearGradient>
      <linearGradient id="gGlassDim" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0" stopColor="rgba(60,66,90,.14)" />
        <stop offset="100%" stopColor="rgba(14,17,26,.3)" />
      </linearGradient>
      <linearGradient id="gRack" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#262d40" />
        <stop offset="55%" stopColor="#1d2434" />
        <stop offset="100%" stopColor="#171d2b" />
      </linearGradient>
      <linearGradient id="gDb" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#242b42" />
        <stop offset="50%" stopColor="#1a2134" />
        <stop offset="100%" stopColor="#151b2a" />
      </linearGradient>
      <linearGradient id="gScreen" x1="0" y1="0" x2="0.2" y2="1">
        <stop offset="0" stopColor="#20273a" />
        <stop offset="100%" stopColor="#141a28" />
      </linearGradient>

      <filter id="blurS" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="2.4" />
      </filter>
      <filter id="blurM" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="6" />
      </filter>

      <marker id="arO" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="6" markerHeight="6"
        orient="auto-start-reverse">
        <path d="M0,1 L9,5 L0,9" fill="none" stroke="#a8c0e4" strokeWidth="1.6"
          strokeLinecap="round" strokeLinejoin="round" />
      </marker>
      <marker id="arE" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="6" markerHeight="6"
        orient="auto-start-reverse">
        <path d="M0,1 L9,5 L0,9" fill="none" stroke="#bcb2ec" strokeWidth="1.6"
          strokeLinecap="round" strokeLinejoin="round" />
      </marker>
      <marker id="arD" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="5" markerHeight="5"
        orient="auto-start-reverse">
        <path d="M0,1 L9,5 L0,9" fill="none" stroke="#39405266" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" />
      </marker>
    </defs>
  );
}
