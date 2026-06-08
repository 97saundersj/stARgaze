import type * as THREE from 'three';
import constellationData from './data/constellation.json';
import type { MessageKey } from './messageOverlay';
import type { ConstellationScene } from './constellationScene';

export type Phase =
  | 'findStars'
  | 'connect'
  | 'reveal'
  | 'theQuestion'
  | 'theMoment';

export const PHASE_INSTRUCTIONS: Record<Phase, string> = {
  findStars: 'Tap or drag across the stars of the constellation.',
  connect: '',
  reveal: '',
  theQuestion: '',
  theMoment: '',
};

export interface PhaseController {
  phase: Phase;
  foundStars: Set<string>;
  onPhaseChange: (phase: Phase) => void;
  onInstructionChange: (text: string) => void;
}

const REVEAL_DURATION = 3;
const QUESTION_AUTO_ADVANCE = 5;

export function createPhaseController(
  scene: ConstellationScene,
  callbacks: {
    onPhaseChange: (phase: Phase) => void;
    onInstructionChange: (text: string) => void;
    onMessageShow: (key: MessageKey, opacity: number) => void;
    onMessageHide: () => void;
  },
): PhaseController & { update: (dt: number) => void; handleStarTap: (starId: string | null, isDecoy: boolean, decoyMesh?: THREE.Mesh) => void; handleTap: () => void } {
  let phase: Phase = 'findStars';
  const foundStars = new Set<string>();

  let revealTimer = 0;
  let questionTimer = 0;
  let fadeProgress = 0;
  let transitioningToQuestion = false;
  let transitioningToMoment = false;

  const totalStars = constellationData.nodes.length;

  function tryAdvanceFromConnect(): void {
    if (scene.allEdgesComplete()) {
      setPhase('reveal');
    }
  }

  function setPhase(next: Phase): void {
    phase = next;
    callbacks.onPhaseChange(next);
    callbacks.onInstructionChange(PHASE_INSTRUCTIONS[next]);

    if (next === 'connect') {
      tryAdvanceFromConnect();
    } else if (next === 'reveal') {
      revealTimer = 0;
      scene.setGlow(true, 0);
      scene.showAllEdges();
    } else if (next === 'theQuestion') {
      transitioningToQuestion = true;
      fadeProgress = 0;
      questionTimer = 0;
      scene.hideDecoys();
      scene.clearTextStars();
    } else if (next === 'theMoment') {
      transitioningToMoment = true;
      fadeProgress = 0;
    }
  }

  function handleStarTap(starId: string | null, isDecoy: boolean, decoyMesh?: THREE.Mesh): void {
    if (phase !== 'findStars') return;

    if (isDecoy && decoyMesh) {
      scene.flashDecoy(decoyMesh);
      return;
    }

    if (!starId || foundStars.has(starId)) return;

    foundStars.add(starId);
    scene.markStarFound(starId);
    scene.revealEdgesForFoundNodes(foundStars);

    if (foundStars.size >= totalStars) {
      setPhase('connect');
    }
  }

  function handleTap(): void {
    if (phase === 'theQuestion') {
      setPhase('theMoment');
    }
  }

  function update(dt: number): void {
    if (phase === 'findStars' || phase === 'connect') {
      scene.updateEdgeAnimations(dt);
      if (phase === 'connect') {
        tryAdvanceFromConnect();
      }
    }

    if (phase === 'reveal') {
      revealTimer += dt;
      scene.updateGlow(performance.now() * 0.001);

      if (revealTimer >= REVEAL_DURATION) {
        scene.setGlow(false, 0);
        setPhase('theQuestion');
      }
    }

    if (phase === 'theQuestion') {
      if (transitioningToQuestion) {
        fadeProgress = Math.min(fadeProgress + dt * 0.8, 1);
        scene.fadeConstellation(1 - fadeProgress);
        callbacks.onMessageShow('question', fadeProgress);
        if (fadeProgress >= 1) transitioningToQuestion = false;
      } else {
        callbacks.onMessageShow('question', 1);
      }

      questionTimer += dt;
      if (questionTimer >= QUESTION_AUTO_ADVANCE) {
        setPhase('theMoment');
      }
    }

    if (phase === 'theMoment') {
      if (transitioningToMoment) {
        fadeProgress = Math.min(fadeProgress + dt * 0.8, 1);
        if (fadeProgress < 0.5) {
          callbacks.onMessageShow('question', 1 - fadeProgress * 2);
        } else {
          callbacks.onMessageShow('moment', (fadeProgress - 0.5) * 2);
        }
        if (fadeProgress >= 1) transitioningToMoment = false;
      } else {
        callbacks.onMessageShow('moment', 1);
      }
    }
  }

  callbacks.onInstructionChange(PHASE_INSTRUCTIONS.findStars);

  return {
    get phase() {
      return phase;
    },
    foundStars,
    onPhaseChange: callbacks.onPhaseChange,
    onInstructionChange: callbacks.onInstructionChange,
    update,
    handleStarTap,
    handleTap,
  };
}
