import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import useClonedGltf, { GltfPrimitive } from './useClonedGltf.jsx';

const mocks = vi.hoisted(() => ({
  clone: vi.fn(),
  useAnimations: vi.fn(),
  useGLTF: vi.fn(),
}));

vi.mock('@react-three/drei', () => ({
  useAnimations: mocks.useAnimations,
  useGLTF: mocks.useGLTF,
}));

vi.mock('three-stdlib', () => ({
  SkeletonUtils: { clone: mocks.clone },
}));

describe('useClonedGltf', () => {
  beforeEach(() => {
    mocks.clone.mockReset();
    mocks.useAnimations.mockReset();
    mocks.useGLTF.mockReset();
  });

  it('clones the cached scene and binds transformed animations to the clone', () => {
    const sourceScene = { name: 'source' };
    const clonedScene = { name: 'clone' };
    const sourceAnimations = [{ name: 'Walk' }];
    const transformedAnimations = [{ name: 'Walk-in-place' }];
    const transformAnimations = vi.fn(() => transformedAnimations);
    const animationState = {
      actions: { 'Walk-in-place': {} },
      mixer: {},
      names: ['Walk-in-place'],
    };
    mocks.useGLTF.mockReturnValue({ scene: sourceScene, animations: sourceAnimations });
    mocks.clone.mockReturnValue(clonedScene);
    mocks.useAnimations.mockReturnValue(animationState);

    const { result, rerender } = renderHook(() => (
      useClonedGltf('/example.glb', transformAnimations)
    ));

    expect(mocks.clone).toHaveBeenCalledWith(sourceScene);
    expect(transformAnimations).toHaveBeenCalledWith(sourceAnimations);
    expect(mocks.useAnimations).toHaveBeenCalledWith(transformedAnimations, clonedScene);
    expect(result.current).toEqual({
      scene: clonedScene,
      animations: transformedAnimations,
      ...animationState,
    });

    rerender();
    expect(mocks.clone).toHaveBeenCalledTimes(1);
    expect(transformAnimations).toHaveBeenCalledTimes(1);
  });

  it('renders shared GLTF resources with disposal disabled', () => {
    const object = {};
    const element = GltfPrimitive({ object, dispose: true, name: 'avatar' });

    expect(element.props).toMatchObject({
      object,
      dispose: null,
      name: 'avatar',
    });
  });
});
