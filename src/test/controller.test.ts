import { describe, expect, it } from "vitest";
import { solveWaveProblem } from "../math/solver";
import type { WaveWorkerRequest } from "../types";
import { WaveAppController } from "../ui/controller";

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: WaveWorkerRequest[] = [];

  postMessage(message: unknown): void {
    this.requests.push(message as WaveWorkerRequest);
  }

  terminate(): void {}

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

describe("WaveAppController preset domains", () => {
  it("atomically replaces an active preset when its domain changes", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );

    expect(worker.requests).toHaveLength(1);
    controller.setScalarField("domainKind", "finite");
    const editing = controller.getViewModel();

    expect(editing.presetId).toBe("gaussian-split");
    expect(editing.problemName).toBe("Gaussian Pulse");
    expect(editing.status).toBe("editing");
    expect(editing.pendingRevision).toBeNull();
    expect(editing.draft.domainKind).toBe("finite");
    expect(editing.draft.f[0]?.lower).toBe("0");
    expect(editing.draft.f[0]?.upper).toBe(editing.draft.domainRight);
    expect(editing.draft.boundaries.left.kind).toBe("dirichlet");
    expect(editing.draft.boundaries.right.kind).toBe("dirichlet");
    expect(worker.requests).toHaveLength(1);

    controller.setScalarField("domainKind", "finite");
    expect(controller.getViewModel().presetId).toBe("gaussian-split");

    expect(controller.commitDraft()).toBe(true);
    expect(worker.requests.at(-1)?.problem.domain.kind).toBe("finite");
    controller.dispose();
  });

  it("selects every example in its natural preferred domain", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );

    for (const [preset, domain] of [
      ["gaussian-split", "infinite"],
      ["square-wave", "infinite"],
      ["fixed-end", "right-half-line"],
      ["standing-wave", "finite"],
      ["mixed-boundaries", "finite"],
      ["boundary-driven", "right-half-line"]
    ] as const) {
      controller.selectPreset(preset);
      const state = controller.getViewModel();
      expect(state.presetId, preset).toBe(preset);
      expect(state.draft.domainKind, preset).toBe(domain);
      expect(worker.requests.at(-1)?.problem.domain.kind, preset).toBe(domain);
    }
    controller.dispose();
  });

  it("keeps the named example selected for ordinary scalar edits", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );

    controller.setScalarField("T", "4");
    controller.setScalarField("xMin", "-7");
    controller.setScalarField("xMax", "7");
    controller.setScalarField("domainLeft", "-1");
    controller.setScalarField("domainRight", "8");
    const state = controller.getViewModel();
    expect(state.presetId).toBe("gaussian-split");
    expect(state.problemName).toBe("Gaussian Pulse");
    expect(state.draft.T).toBe("4");
    expect(state.draft.xMin).toBe("-7");
    expect(state.draft.xMax).toBe("7");
    controller.dispose();
  });

  it("switches to Custom only for initial-data and boundary edits", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );

    let draft = controller.getViewModel().draft;
    controller.setPieceField("f", draft.f[0]!.id, "expression", "exp(-x^2)");
    expect(controller.getViewModel()).toMatchObject({
      presetId: "custom",
      problemName: "Custom problem"
    });

    controller.selectPreset("fixed-end");
    controller.setBoundaryField("left", "kind", "neumann");
    expect(controller.getViewModel().presetId).toBe("custom");

    controller.selectPreset("gaussian-split");
    expect(controller.addPiece("g")).toBe(true);
    draft = controller.getViewModel().draft;
    expect(draft.g).toHaveLength(2);
    expect(controller.getViewModel().presetId).toBe("custom");
    controller.dispose();
  });

  it("lets the user select Custom without changing or resubmitting the draft", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );
    controller.setScalarField("T", "9");
    const before = controller.getViewModel();
    const requestCount = worker.requests.length;

    controller.selectPreset("custom");
    const custom = controller.getViewModel();
    expect(custom.presetId).toBe("custom");
    expect(custom.problemName).toBe("Custom problem");
    expect(custom.draft).toEqual(before.draft);
    expect(custom.status).toBe(before.status);
    expect(custom.pendingRevision).toBe(before.pendingRevision);
    expect(worker.requests).toHaveLength(requestCount);
    controller.dispose();
  });

  it("shows exact pi sources throughout each pi-based preset variant", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );

    controller.selectPreset("standing-wave");
    controller.setScalarField("domainKind", "infinite");
    let draft = controller.getViewModel().draft;
    expect(draft.T).toBe("2 * pi");
    expect(draft.xMin).toBe("-pi");
    expect(draft.xMax).toBe("pi");

    controller.setScalarField("domainKind", "finite");
    draft = controller.getViewModel().draft;
    expect(draft.T).toBe("2 * pi");
    expect(draft.domainRight).toBe("pi");
    expect(draft.xMax).toBe("pi");
    expect(draft.f[0]?.upper).toBe("pi");
    expect(draft.g[0]?.upper).toBe("pi");

    controller.selectPreset("mixed-boundaries");
    controller.setScalarField("domainKind", "right-half-line");
    draft = controller.getViewModel().draft;
    expect(draft.T).toBe("4 * pi");
    expect(draft.xMin).toBe("0");
    expect(draft.xMax).toBe("2 * pi");
    controller.dispose();
  });

  it("scales accepted resolution with view span, final time, and discontinuities", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );

    expect(worker.requests[0]).toMatchObject({ xSamples: 513, tSamples: 161 });
    controller.selectPreset("square-wave");
    expect(worker.requests.at(-1)).toMatchObject({ xSamples: 1025, tSamples: 401 });
    controller.setScalarField("T", "3 * pi");
    expect(controller.getViewModel().presetId).toBe("square-wave");
    expect(controller.commitDraft()).toBe(true);
    expect(worker.requests.at(-1)).toMatchObject({ xSamples: 1025, tSamples: 385 });
    controller.selectPreset("standing-wave");
    expect(worker.requests.at(-1)).toMatchObject({ xSamples: 513, tSamples: 129 });
    controller.dispose();
  });

  it("evaluates safe constant expressions for time and view bounds", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );

    controller.setScalarField("T", "2 * pi");
    controller.setScalarField("xMin", "-sin(pi / 2) * pi");
    controller.setScalarField("xMax", "pi");
    expect(controller.commitDraft()).toBe(true);

    const problem = worker.requests.at(-1)?.problem;
    expect(problem?.T).toBeCloseTo(2 * Math.PI);
    expect(problem?.view.xMin).toBeCloseTo(-Math.PI);
    expect(problem?.view.xMax).toBeCloseTo(Math.PI);
    controller.dispose();
  });

  it.each(["T", "xMin", "xMax"] as const)(
    "retains an invalid %s expression without replacing the last request",
    (field) => {
      const worker = new FakeWorker();
      const controller = new WaveAppController(
        () => worker as unknown as Worker
      );
      const acceptedRequestCount = worker.requests.length;

      controller.setScalarField(field, "x + 1");
      expect(controller.commitDraft()).toBe(false);
      const state = controller.getViewModel();
      expect(state.draft[field]).toBe("x + 1");
      expect(state.status).toBe("invalid");
      expect(state.statusMessage).toContain("finite constant expression");
      expect(worker.requests).toHaveLength(acceptedRequestCount);
      controller.dispose();
    }
  );

  it("does not create the removed right-bounded half-line from editor input", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );

    controller.setScalarField("domainKind", "left-half-line");
    expect(controller.getViewModel().draft.domainKind).toBe("infinite");
    expect(controller.getViewModel().presetId).toBe("gaussian-split");
    expect(worker.requests).toHaveLength(1);
    controller.dispose();
  });

  it("does not accept the previous result while a domain variant awaits debounce", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );
    const first = worker.requests[0] as WaveWorkerRequest;

    controller.setScalarField("domainKind", "right-half-line");
    worker.emit({
      type: "result",
      result: solveWaveProblem(first.problem, { revision: first.revision })
    });

    const state = controller.getViewModel();
    expect(state.status).toBe("editing");
    expect(state.draft.domainKind).toBe("right-half-line");
    expect(state.acceptedProblem).toBeNull();
    expect(state.result).toBeNull();
    controller.dispose();
  });

  it("evaluates safe constant expressions at physical endpoints and fixes c to one", () => {
    const worker = new FakeWorker();
    const controller = new WaveAppController(
      () => worker as unknown as Worker
    );

    controller.setScalarField("domainKind", "finite");
    controller.setScalarField("domainLeft", "sin(pi / 2) - 1");
    controller.setScalarField("domainRight", "2 * π");
    controller.setScalarField("xMin", "0");
    controller.setScalarField("xMax", "6");
    // Keep finite-domain initial pieces consistent with the edited endpoints.
    const draft = controller.getViewModel().draft;
    controller.setPieceField("f", draft.f[0]!.id, "lower", "sin(pi / 2) - 1");
    controller.setPieceField("f", draft.f[0]!.id, "upper", "2 * π");
    controller.setPieceField("g", draft.g[0]!.id, "lower", "sin(pi / 2) - 1");
    controller.setPieceField("g", draft.g[0]!.id, "upper", "2 * π");

    expect(controller.commitDraft()).toBe(true);
    const problem = worker.requests.at(-1)?.problem;
    expect(problem?.c).toBe(1);
    expect(problem?.domain).toEqual({
      kind: "finite",
      left: 0,
      right: 2 * Math.PI
    });
    controller.dispose();
  });

  it.each(["x", "unknown", "1 / 0", "sqrt(-1)"])(
    "retains an invalid endpoint draft for %s without submitting it",
    (expression) => {
      const worker = new FakeWorker();
      const controller = new WaveAppController(
        () => worker as unknown as Worker
      );
      controller.setScalarField("domainKind", "right-half-line");
      expect(controller.commitDraft()).toBe(true);
      const acceptedRequestCount = worker.requests.length;

      controller.setScalarField("domainLeft", expression);
      expect(controller.commitDraft()).toBe(false);
      const state = controller.getViewModel();
      expect(state.draft.domainLeft).toBe(expression);
      expect(state.status).toBe("invalid");
      expect(state.statusMessage).toContain("finite constant expression");
      expect(worker.requests).toHaveLength(acceptedRequestCount);
      controller.dispose();
    }
  );
});
