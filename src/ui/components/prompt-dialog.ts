import { Input, type Component } from "@earendil-works/pi-tui";

/** Single-line text prompt used inside a PanelOverlay (API keys, goal edits, OAuth codes). */
export class PromptDialog implements Component {
  private input: Input;

  constructor(
    prompt: string,
    placeholder: string,
    onSubmit: (value: string) => void,
    onCancel: () => void,
  ) {
    this.input = new Input({ prompt, placeholder });
    this.input.focused = true;
    this.input.onSubmit = (value) => onSubmit(value);
    this.input.onEscape = () => onCancel();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    this.input.focused = true;
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    return this.input.render(width);
  }
}
