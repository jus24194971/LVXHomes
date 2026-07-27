declare module "@mkkellogg/gaussian-splats-3d" {
  export const SceneFormat: { Splat: number; KSplat: number; Ply: number };
  export class Viewer {
    constructor(options?: Record<string, unknown>);
    addSplatScene(url: string, options?: Record<string, unknown>): Promise<void>;
    start(): void;
    stop(): void;
    dispose(): void;
  }
}
