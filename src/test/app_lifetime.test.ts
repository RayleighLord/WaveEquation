import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLifetime } from "../ui/lifetime";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("application lifetime", () => {
  it("detaches an old mount while a new mount continues handling native events", () => {
    const oldMount = new AppLifetime();
    const newMount = new AppLifetime();
    const oldClick = vi.fn();
    const newClick = vi.fn();
    const button = document.createElement("button");
    oldMount.on(button, "click", oldClick);
    newMount.on(button, "click", newClick);
    oldMount.dispose();
    oldMount.dispose();
    button.click();
    expect(oldClick).not.toHaveBeenCalled();
    expect(newClick).toHaveBeenCalledOnce();
    newMount.dispose();
  });

  it("prevents queued frame stages and debounce work from touching a disposed app", () => {
    vi.useFakeTimers();
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const lifetime = new AppLifetime();
    const effect = vi.fn();
    lifetime.frame(() => lifetime.frame(effect));
    callbacks[0]?.(0);
    lifetime.timeout(effect, 260);
    lifetime.dispose();
    callbacks[1]?.(16);
    vi.runAllTimers();
    expect(effect).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(2);
    expect(lifetime.frame(effect)).toBe(0);
  });
});
