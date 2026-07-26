import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The three.js stack can't run in jsdom (no WebGL context) and none of it is
// under test here — this file covers the chrome AROUND the canvas (the download
// link + the empty-src guard). Bounds drops the model subtree: mounting
// <primitive>/<mesh> would surface unknown DOM elements and r3f hands back
// HTMLElement refs without the three.js API. Canvas retains the lighting and
// environment elements so their interactive wiring stays covered.
// `mockScene` stands in for the three.js scene `useThree` hands the viewer, so
// the environment-intensity assertions below check the value the component
// actually writes onto the scene — not merely a prop handed to a mocked
// <Environment>, which would stay green through the exact regression the
// source guards against (memoizing the environment children).
const { mockScene } = vi.hoisted(() => ({ mockScene: {} }));
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }) => <div data-testid="glb-canvas">{children}</div>,
  useThree: (selector) => selector({ scene: mockScene }),
}));
vi.mock('@react-three/drei', () => ({
  Canvas: () => null,
  OrbitControls: () => null,
  Environment: ({ background, backgroundBlurriness, files, children }) => (
    <div
      data-testid="glb-environment"
      data-background={background ? 'visible' : 'hidden'}
      data-background-blurriness={backgroundBlurriness}
      data-files={files}
    >
      {children}
    </div>
  ),
  Bounds: () => null,
  useGLTF: Object.assign(() => ({ scene: {} }), { clear: vi.fn() }),
}));

import GlbViewer, { cloneGlbSceneWithOpaqueMaterials } from './GlbViewer';

const openControls = () => fireEvent.click(screen.getByLabelText('Preview display settings'));

describe('GlbViewer', () => {
  it('renders nothing without a src', () => {
    const { container } = render(<GlbViewer src="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the canvas and a download link derived from the src filename', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    expect(screen.getByTestId('glb-canvas')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Download \.glb/i });
    expect(link).toHaveAttribute('href', '/data/models3d/robot-a1b2.glb');
    expect(link).toHaveAttribute('download', 'robot-a1b2.glb');
  });

  // The controls used to be an always-mounted overlay pinned inside the canvas,
  // which covered the upper-right quadrant of every model.
  it('keeps the display controls collapsed and outside the render surface', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    expect(screen.queryByLabelText('Mesh preview background')).not.toBeInTheDocument();

    openControls();

    const picker = screen.getByLabelText('Mesh preview background');
    expect(screen.getByTestId('glb-preview-surface')).not.toContainElement(picker);
    expect(screen.getByLabelText('Preview display settings')).toHaveAttribute('aria-expanded', 'true');

    openControls();
    expect(screen.queryByLabelText('Mesh preview background')).not.toBeInTheDocument();
  });

  it('lets the user change the mesh preview background', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    openControls();
    const picker = screen.getByLabelText('Mesh preview background');
    expect(picker).toHaveValue('#050505');

    fireEvent.change(picker, { target: { value: '#f5f5f5' } });

    expect(picker).toHaveValue('#f5f5f5');
    expect(screen.getByTestId('glb-preview-surface'))
      .toHaveStyle({ backgroundColor: '#f5f5f5' });
  });

  it('loads the bundled HDRI as a softly blurred background by default', () => {
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    openControls();

    const ambient = screen.getByLabelText('Ambient light');
    const key = screen.getByLabelText('Key light');
    const fill = screen.getByLabelText('Fill light');
    expect(ambient).toHaveValue('0.6');
    expect(key).toHaveValue('1.2');
    expect(fill).toHaveValue('0.4');
    expect(screen.getByTestId('glb-environment')).toHaveAttribute(
      'data-files',
      '/hdri/studio-small-08-1k.hdr',
    );
    expect(screen.getByTestId('glb-environment')).toHaveAttribute('data-background', 'visible');
    expect(screen.getByTestId('glb-environment')).toHaveAttribute(
      'data-background-blurriness',
      '0.2',
    );
    expect(screen.getByLabelText('Show HDRI background')).toBeChecked();

    fireEvent.change(ambient, { target: { value: '1.4' } });
    fireEvent.change(key, { target: { value: '2.2' } });
    fireEvent.change(fill, { target: { value: '0.8' } });
    fireEvent.click(screen.getByLabelText('Show HDRI background'));

    expect(ambient).toHaveValue('1.4');
    expect(key).toHaveValue('2.2');
    expect(fill).toHaveValue('0.8');
    expect(screen.getByLabelText('Show HDRI background')).not.toBeChecked();
    expect(screen.getByTestId('glb-environment')).toHaveAttribute('data-background', 'hidden');
  });

  it('ships the referenced environment as a Radiance HDR asset', () => {
    const hdriPath = resolve(process.cwd(), 'public/hdri/studio-small-08-1k.hdr');
    const header = readFileSync(hdriPath).subarray(0, 128).toString('ascii');
    expect(header).toMatch(/^#\?RADIANCE/);
  });

  // The image-based lighting drowned out the three light sliders at full
  // strength — dialing the environment down is what makes them visible.
  it('writes the environment intensity onto the scene from its own slider', () => {
    delete mockScene.environmentIntensity;
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    openControls();

    const environment = screen.getByLabelText('Environment light');
    expect(environment).toHaveValue('0.6');
    expect(mockScene.environmentIntensity).toBe(0.6);

    fireEvent.change(environment, { target: { value: '0' } });

    expect(environment).toHaveValue('0');
    // 0 is a meaningful value (lights-only), not an absent one.
    expect(mockScene.environmentIntensity).toBe(0);
  });

  // drei's Environment snapshots scene.environmentIntensity before we write it
  // and restores that snapshot whenever its own effect re-runs — and toggling
  // the HDRI background is the one thing that still re-runs it. Without a
  // re-assert the IBL silently returns to full strength while the slider still
  // reads the user's value. The mocked Environment can't perform the restore,
  // so stand in for it by writing the pre-write default back onto the scene.
  it('re-asserts the environment intensity when the HDRI background is toggled', () => {
    delete mockScene.environmentIntensity;
    render(<GlbViewer src="/data/models3d/robot-a1b2.glb" />);
    openControls();
    fireEvent.change(screen.getByLabelText('Environment light'), { target: { value: '0' } });
    expect(mockScene.environmentIntensity).toBe(0);

    mockScene.environmentIntensity = 1; // drei restoring its pre-write snapshot
    fireEvent.click(screen.getByLabelText('Show HDRI background'));

    expect(mockScene.environmentIntensity).toBe(0);
  });

  it('honors an explicit downloadName over the derived one', () => {
    render(<GlbViewer src="/data/models3d/x.glb?v=2" downloadName="my-mesh.glb" />);
    expect(screen.getByRole('link', { name: /Download \.glb/i })).toHaveAttribute('download', 'my-mesh.glb');
  });

  it('falls back to model.glb when the src has no .glb tail', () => {
    render(<GlbViewer src="/data/models3d/streaming-endpoint" />);
    expect(screen.getByRole('link', { name: /Download \.glb/i })).toHaveAttribute('download', 'model.glb');
  });

  it('clones and makes legacy generated materials opaque without mutating the cached scene', () => {
    const scene = new Group();
    const material = new MeshStandardMaterial({
      opacity: 0.2,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.5,
    });
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), material));

    const clone = cloneGlbSceneWithOpaqueMaterials(scene);
    const clonedMaterial = clone.children[0].material;
    expect(clone).not.toBe(scene);
    expect(clonedMaterial).not.toBe(material);
    expect(clonedMaterial).toMatchObject({
      transparent: false,
      opacity: 1,
      alphaTest: 0,
      depthWrite: true,
    });
    expect(material).toMatchObject({ transparent: true, opacity: 0.2, depthWrite: false });
  });
});
