import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { computeDistrictBounds } from '../../utils/openWorldMiniMap';
import { listRegions, regionWarpPadPosition } from '../../utils/openWorldRegions';
import { PIXEL_FONT_URL, openWorldDayMix, openWorldShowDetail } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import OpenWorldLabel from './OpenWorldLabel';

function SignalBeacon({ position, color, label, sublabel, intensity = 1, dayMix = 0 }) {
  const { tintStructure } = useOpenWorldPalette();
  const groupRef = useRef();
  const glowRef = useRef();
  const beamRef = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const pulse = 0.7 + ((Math.sin(t * (1.5 + intensity)) + 1) / 2) * 0.8 * intensity;

    if (groupRef.current) {
      groupRef.current.position.y = position[1] + Math.sin(t * 0.6 + position[0]) * 0.1;
    }
    if (glowRef.current) {
      glowRef.current.material.opacity = 0.15 * pulse;
      glowRef.current.scale.setScalar(0.9 + pulse * 0.15);
    }
    if (beamRef.current) {
      beamRef.current.material.opacity = Math.min(0.35, 0.08 + pulse * 0.08);
    }
  });

  return (
    <group ref={groupRef} position={position}>
      <mesh ref={beamRef} position={[0, 2.8, 0]}>
        <cylinderGeometry args={[0.08, 0.45, 5.5, 12, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[0.35, 0.45, 0.3, 10]} />
        <meshStandardMaterial color={tintStructure('#0a0a18')} emissive={color} emissiveIntensity={0.35 * intensity} />
      </mesh>

      <mesh position={[0, 0.42, 0]}>
        <sphereGeometry args={[0.18, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.95} />
      </mesh>

      <mesh ref={glowRef} position={[0, 0.42, 0]}>
        <sphereGeometry args={[0.5, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <OpenWorldLabel
        position={[0, 5.9, 0]}
        fontSize={0.32}
        color={color}
        dayMix={dayMix}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
      >
        {label}
      </OpenWorldLabel>
      {sublabel && (
        <OpenWorldLabel
          position={[0, 5.45, 0]}
          fontSize={0.18}
          color="#cbd5e1"
          dayMix={dayMix}
          anchorX="center"
          anchorY="middle"
          font={PIXEL_FONT_URL}
          maxWidth={6}
        >
          {sublabel}
        </OpenWorldLabel>
      )}
    </group>
  );
}

function WarpPad({ region, active, detailed, dayMix, onTravel }) {
  const { accent, tintStructure } = useOpenWorldPalette();
  const groupRef = useRef();
  const ringRef = useRef();
  const beamRef = useRef();
  const color = active ? '#fff4d6' : accent;
  const position = regionWarpPadPosition(region);

  useFrame(({ clock }) => {
    if (!position) return;
    const t = clock.getElapsedTime();
    const pulse = 0.72 + (Math.sin(t * 2.2 + region.id.length) + 1) * 0.14;
    if (groupRef.current) groupRef.current.position.y = position[1] + Math.sin(t * 0.8 + region.id.length) * 0.025;
    if (ringRef.current) {
      ringRef.current.rotation.z = t * 0.35;
      ringRef.current.material.opacity = 0.35 + pulse * 0.25;
    }
    if (beamRef.current) beamRef.current.material.opacity = detailed ? 0.05 + pulse * 0.07 : 0;
  });

  if (!position) return null;

  return (
    <group
      ref={groupRef}
      position={position}
      onClick={(event) => {
        event.stopPropagation();
        onTravel?.(region);
      }}
    >
      {/* The pad is always present, including the low tier, because it is an interaction
          surface rather than decoration. Its hit area is intentionally larger than the disc. */}
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[2.2, 2.2, 0.16, 24]} />
        <meshStandardMaterial color={tintStructure('#13212a')} emissive={color} emissiveIntensity={active ? 1.1 : 0.5} roughness={0.8} metalness={0} />
      </mesh>
      <mesh ref={ringRef} position={[0, 0.1, 0]} rotation={[0, 0, Math.PI / 4]}>
        <torusGeometry args={[1.45, 0.08, 8, 4]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      {detailed && (
        <mesh ref={beamRef} position={[0, 3.2, 0]}>
          <cylinderGeometry args={[0.08, 0.72, 6.2, 12, 1, true]} />
          <meshBasicMaterial color={color} transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      <OpenWorldLabel
        position={[0, detailed ? 6.45 : 2, 0]}
        fontSize={detailed ? 0.3 : 0.22}
        color={color}
        dayMix={dayMix}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
      >
        {region.label}
      </OpenWorldLabel>
      {detailed && (
        <OpenWorldLabel
          position={[0, 5.98, 0]}
          fontSize={0.16}
          color="#d8e5ea"
          dayMix={dayMix}
          anchorX="center"
          anchorY="middle"
          font={PIXEL_FONT_URL}
        >
          F TO WARP
        </OpenWorldLabel>
      )}
    </group>
  );
}

export default function OpenWorldSignalBeacons({ positions, reviewCounts, instances, settings, activeRegionId, onTravelToRegion }) {
  const dayMix = openWorldDayMix(settings);
  const regions = useMemo(() => listRegions(), []);
  const showDetail = openWorldShowDetail(settings);
  const config = useMemo(() => {
    if (!positions || positions.size === 0) return [];

    const bounds = computeDistrictBounds(positions, 'downtown');
    if (!bounds) return [];
    const { minX, maxX, minZ, maxZ } = bounds;

    const pending = reviewCounts?.total || 0;
    const alerts = reviewCounts?.alert || 0;
    const peers = instances?.peers || [];
    const onlinePeers = peers.filter(peer => peer.status === 'online').length;
    const totalNodes = 1 + peers.length;

    return [
      {
        id: 'review-beacon',
        position: [minX - 6, 0, minZ - 6],
        color: alerts > 0 ? '#f97316' : '#06b6d4',
        label: alerts > 0 ? 'REVIEW PRESSURE' : 'REVIEW HUB',
        sublabel: pending > 0 ? `${pending} pending · ${alerts} alerts` : 'inbox clear',
        intensity: alerts > 0 ? 1.6 : pending > 0 ? 1.1 : 0.7,
      },
      {
        id: 'void-beacon',
        position: [maxX + 8, 0, maxZ + 8],
        color: onlinePeers > 0 ? '#8b5cf6' : '#64748b',
        label: 'INSTANCE MESH',
        sublabel: `${onlinePeers}/${totalNodes} nodes linked`,
        intensity: onlinePeers > 0 ? 1.2 : 0.65,
      }
    ];
  }, [positions, reviewCounts, instances]);

  if (config.length === 0 && regions.length === 0) return null;

  return (
    <group>
      {config.map(beacon => (
        <SignalBeacon key={beacon.id} {...beacon} dayMix={dayMix} />
      ))}
      {regions.map((region) => (
        <WarpPad
          key={`warp-pad-${region.id}`}
          region={region}
          active={region.id === activeRegionId}
          detailed={showDetail}
          dayMix={dayMix}
          onTravel={onTravelToRegion}
        />
      ))}
    </group>
  );
}
