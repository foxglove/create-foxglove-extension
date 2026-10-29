import type {
  Immutable,
  SettingsTree,
  SettingsTreeAction,
  SettingsTreeField,
  SettingsTreeNode,
} from "@foxglove/extension";

type Field = Immutable<SettingsTreeField>;
type Node = Immutable<SettingsTreeNode>;
type Dispatch = (action: SettingsTreeAction) => void;

let nextId = 0;
function uniqueId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  properties: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), properties);
}

/** Puts `children` into `parent` in order, moving only the elements that are out of place */
function syncChildren(parent: HTMLElement, children: readonly Element[]): void {
  children.forEach((child, index) => {
    if (parent.children[index] !== child) {
      parent.insertBefore(child, parent.children[index] ?? null);
    }
  });
  while (parent.children.length > children.length) {
    parent.lastElementChild?.remove();
  }
}

function setText(target: HTMLElement, text: string | undefined): void {
  target.textContent = text ?? "";
  target.hidden = text == undefined || text === "";
}

/** Sets an input's value unless the user is typing in it */
function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if (document.activeElement !== input && input.value !== value) {
    input.value = value;
  }
}

/** Children in display order: nodes with an `order` first, then the rest in object order */
function orderedChildren(node: Node): [string, Node][] {
  const entries = Object.entries(node.children ?? {}).filter(
    (entry): entry is [string, Node] => entry[1] != undefined,
  );
  if (node.childrenReorderable != undefined && node.childrenReorderable !== false) {
    return entries;
  }
  const withOrder = entries.filter(([, child]) => child.order != undefined);
  const withoutOrder = entries.filter(([, child]) => child.order == undefined);
  withOrder.sort(([, a], [, b]) => {
    const orderA = a.order!;
    const orderB = b.order!;
    if (typeof orderA === "number" && typeof orderB === "number") {
      return orderA - orderB;
    }
    return String(orderA).localeCompare(String(orderB));
  });
  return [...withOrder, ...withoutOrder];
}

/** One field of a node. Each input type builds its own controls. */
class FieldView {
  public readonly element = element("div");
  public readonly input: Field["input"];
  readonly #messages = element("div");
  readonly #caption = element("p");
  readonly #help = element("p");
  readonly #error = element("p");
  readonly #warning = element("p");
  #field: Field;
  #label: HTMLElement;
  #controls: (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] = [];
  #update: (field: Field) => void = () => undefined;

  public constructor(
    private readonly path: readonly string[],
    field: Field,
    private readonly dispatch: Dispatch,
  ) {
    this.#field = field;
    this.input = field.input;
    this.element.dataset.settingsPath = path.join(".");
    this.element.style.display = "grid";
    this.element.style.gap = "2px";
    this.#help.id = uniqueId("help");
    this.#error.dataset.kind = "error";
    this.#warning.dataset.kind = "warning";
    this.#messages.append(this.#caption, this.#help, this.#error, this.#warning);
    this.#label = this.build(field);
    this.element.append(this.#messages);
    this.update(field);
  }

  public get label(): string {
    return this.#field.label;
  }

  public update(field: Field): void {
    this.#field = field;
    if (this.#label instanceof HTMLLegendElement || this.#label instanceof HTMLLabelElement) {
      this.#label.textContent = field.label;
    }
    setText(this.#caption, field.caption);
    setText(this.#help, field.help);
    setText(this.#error, field.error == undefined ? undefined : `Error: ${field.error}`);
    setText(
      this.#warning,
      field.error == undefined && field.warning != undefined
        ? `Warning: ${field.warning}`
        : undefined,
    );
    // Some inputs, such as toggles, create their controls when they update
    this.#update(field);
    for (const control of this.#controls) {
      const readOnly = field.readonly === true;
      // Text can be read-only. Other controls can only be disabled.
      const textLike =
        control instanceof HTMLTextAreaElement ||
        (control instanceof HTMLInputElement && isTextLike(control));
      control.disabled = field.disabled === true || (readOnly && !textLike);
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        control.readOnly = readOnly;
      }
      if (field.help != undefined) {
        control.setAttribute("aria-describedby", this.#help.id);
      }
    }
  }

  #send(value: unknown): void {
    this.dispatch({
      action: "update",
      payload: { path: this.path, input: this.input, value },
    } as SettingsTreeAction);
  }

  /** A single labeled control */
  #single(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): HTMLLabelElement {
    control.id = uniqueId("field");
    const label = element("label", { htmlFor: control.id });
    this.#controls = [control];
    this.element.append(label, control);
    return label;
  }

  /** Several controls, grouped under the field's label */
  #group(controls: HTMLElement[]): HTMLLegendElement {
    const fieldset = element("fieldset");
    fieldset.style.border = "none";
    fieldset.style.margin = "0";
    fieldset.style.padding = "0";
    const legend = element("legend");
    fieldset.append(legend, ...controls);
    this.element.append(fieldset);
    return legend;
  }

  private build(field: Field): HTMLElement {
    switch (field.input) {
      case "string":
      case "messagepath":
      case "rgb":
      case "rgba": {
        const input = element("input", { type: "text" });
        input.addEventListener("input", () => {
          this.#send(input.value);
        });
        this.#update = (next) => {
          const value = next as Extract<Field, { input: "string" }>;
          input.placeholder = "placeholder" in value ? (value.placeholder ?? "") : "";
          setInputValue(input, value.value ?? "");
        };
        const label = this.#single(input);
        if (field.input === "rgb" || field.input === "rgba") {
          const clear = element("button", { type: "button", textContent: "Clear" });
          clear.setAttribute("aria-label", `Clear ${field.label}`);
          clear.addEventListener("click", () => {
            this.#send(undefined);
          });
          this.element.append(clear);
          const previous = this.#update;
          this.#update = (next) => {
            previous(next);
            clear.hidden = (next as Extract<Field, { input: "rgb" }>).hideClearButton === true;
            clear.disabled = next.disabled === true || next.readonly === true;
          };
        }
        return label;
      }
      case "autocomplete": {
        const input = element("input", { type: "text" });
        const list = element("datalist", { id: uniqueId("items") });
        input.setAttribute("list", list.id);
        input.addEventListener("input", () => {
          this.#send(input.value);
        });
        this.#update = (next) => {
          const value = next as Extract<Field, { input: "autocomplete" }>;
          input.placeholder = value.placeholder ?? "";
          setInputValue(input, value.value ?? "");
          list.replaceChildren(...value.items.map((item) => element("option", { value: item })));
        };
        const label = this.#single(input);
        this.element.append(list);
        return label;
      }
      case "multiline-string": {
        const textarea = element("textarea");
        textarea.addEventListener("input", () => {
          this.#send(textarea.value);
        });
        this.#update = (next) => {
          const value = next as Extract<Field, { input: "multiline-string" }>;
          textarea.placeholder = value.placeholder ?? "";
          setInputValue(textarea, value.value ?? "");
        };
        return this.#single(textarea);
      }
      case "number": {
        const input = element("input", { type: "number" });
        input.addEventListener("input", () => {
          if (input.value === "") {
            this.#send(undefined);
          } else if (!Number.isNaN(input.valueAsNumber)) {
            this.#send(normalizeNumber(input.valueAsNumber, this.#field as NumberBounds));
          }
        });
        this.#update = (next) => {
          const value = next as Extract<Field, { input: "number" }>;
          input.placeholder = value.placeholder ?? "";
          input.step = value.step == undefined ? "any" : String(value.step);
          input.min = value.min == undefined ? "" : String(value.min);
          input.max = value.max == undefined ? "" : String(value.max);
          setInputValue(input, value.value == undefined ? "" : String(value.value));
        };
        return this.#single(input);
      }
      case "boolean": {
        const input = element("input", { type: "checkbox" });
        input.addEventListener("change", () => {
          this.#send(input.checked);
        });
        this.#update = (next) => {
          input.checked = (next as Extract<Field, { input: "boolean" }>).value === true;
        };
        return this.#single(input);
      }
      case "select": {
        const select = element("select");
        let values: readonly unknown[] = [];
        select.addEventListener("change", () => {
          const selected = [...select.selectedOptions].map(
            (option) => values[Number(option.dataset.index)],
          );
          this.#send(select.multiple ? selected : selected[0]);
        });
        this.#update = (next) => {
          const value = next as Extract<Field, { input: "select" }>;
          values = value.options.map((option) => option.value);
          select.multiple = Array.isArray(value.value);
          const current: readonly unknown[] = Array.isArray(value.value)
            ? (value.value as readonly unknown[])
            : [value.value];
          const options = value.options.map((option, index) => {
            const item = element("option", {
              textContent: option.label,
              disabled: option.disabled === true,
              selected: current.includes(option.value),
            });
            item.dataset.index = String(index);
            return item;
          });
          // A value that matches no option shows as empty, rather than as the first option
          const matched = options.some((option) => option.selected);
          const placeholder =
            select.multiple || matched
              ? []
              : [element("option", { selected: true, disabled: true, hidden: true })];
          select.replaceChildren(...placeholder, ...options);
        };
        return this.#single(select);
      }
      case "toggle": {
        const container = element("div");
        container.setAttribute("role", "radiogroup");
        const name = uniqueId("toggle");
        this.#update = (next) => {
          const value = next as Extract<Field, { input: "toggle" }>;
          const options = (value.options as readonly unknown[]).map((option) =>
            typeof option === "object" && option != undefined
              ? (option as { label: string; value: unknown })
              : { label: String(option), value: option },
          );
          const radios = options.map((option) => {
            const radio = element("input", {
              type: "radio",
              name,
              checked: option.value === value.value,
            });
            radio.addEventListener("change", () => {
              this.#send(option.value);
            });
            const optionLabel = element("label");
            optionLabel.append(radio, ` ${option.label}`);
            return { radio, optionLabel };
          });
          this.#controls = radios.map(({ radio }) => radio);
          container.replaceChildren(...radios.map(({ optionLabel }) => optionLabel));
          for (const radio of this.#controls) {
            radio.disabled = next.disabled === true || next.readonly === true;
          }
        };
        return this.#group([container]);
      }
      case "gradient": {
        const inputs = [element("input", { type: "text" }), element("input", { type: "text" })];
        const parts = ["start", "end"];
        inputs.forEach((input, index) => {
          input.setAttribute("aria-label", `${field.label} ${parts[index] ?? ""}`);
          input.addEventListener("input", () => {
            this.#send(inputs.map((item) => item.value));
          });
        });
        this.#controls = inputs;
        this.#update = (next) => {
          const value = (next as Extract<Field, { input: "gradient" }>).value;
          inputs.forEach((input, index) => {
            setInputValue(input, value?.[index] ?? "");
            input.setAttribute("aria-label", `${next.label} ${parts[index] ?? ""}`);
          });
        };
        return this.#group(inputs);
      }
      case "vec2":
      case "vec3": {
        const size = field.input === "vec2" ? 2 : 3;
        const inputs = Array.from({ length: size }, () => element("input", { type: "number" }));
        for (const input of inputs) {
          input.addEventListener("input", () => {
            this.#send(
              inputs.map((item) =>
                item.value === "" || Number.isNaN(item.valueAsNumber)
                  ? undefined
                  : normalizeNumber(item.valueAsNumber, this.#field as NumberBounds),
              ),
            );
          });
        }
        this.#controls = inputs;
        this.#update = (next) => {
          const value = next as Extract<Field, { input: "vec3" }>;
          const labels: readonly string[] = value.labels ?? ["X", "Y", "Z"];
          inputs.forEach((input, index) => {
            input.setAttribute("aria-label", `${next.label} ${labels[index] ?? index}`);
            input.step = value.step == undefined ? "any" : String(value.step);
            input.min = value.min == undefined ? "" : String(value.min);
            input.max = value.max == undefined ? "" : String(value.max);
            input.placeholder = value.placeholder?.[index] ?? "";
            const item = value.value?.[index];
            setInputValue(input, item == undefined ? "" : String(item));
          });
        };
        return this.#group(inputs);
      }
    }
  }
}

function isTextLike(input: HTMLInputElement): boolean {
  return input.type === "text" || input.type === "number";
}

/** One node of the tree, with its fields and children */
class NodeView {
  public readonly element = element("details", { open: true });
  readonly #summary = element("summary");
  readonly #swatch = element("span");
  readonly #labelText = element("span");
  readonly #body = element("div");
  readonly #controls = element("div");
  readonly #visible = element("input", { type: "checkbox" });
  readonly #visibleLabel = element("label");
  readonly #rename = element("input", { type: "text" });
  readonly #actions = element("div");
  readonly #messages = element("div");
  readonly #help = element("p");
  readonly #error = element("p");
  readonly #warning = element("p");
  readonly #fieldsElement = element("div");
  readonly #childrenElement = element("div");
  readonly #fields = new Map<string, FieldView>();
  readonly #children = new Map<string, NodeView>();
  #node: Node | undefined;
  #initialized = false;

  public constructor(
    public readonly path: readonly string[],
    private readonly dispatch: Dispatch,
  ) {
    this.element.dataset.settingsPath = path.join(".");
    this.element.style.marginLeft = path.length > 1 ? "8px" : "0";
    this.#swatch.style.display = "inline-block";
    this.#swatch.style.width = "0.75em";
    this.#swatch.style.height = "0.75em";
    this.#swatch.style.marginRight = "4px";
    this.#summary.append(this.#swatch, this.#labelText);
    this.#visibleLabel.append(this.#visible, " Visible");
    this.#visible.addEventListener("change", () => {
      this.#sendUpdate([...path, "visible"], "boolean", this.#visible.checked);
    });
    this.#rename.addEventListener("change", () => {
      this.#sendUpdate([...path, "label"], "string", this.#rename.value);
    });
    this.#controls.style.display = "flex";
    this.#controls.style.flexWrap = "wrap";
    this.#controls.style.gap = "4px";
    this.#controls.append(this.#visibleLabel, this.#rename, this.#actions);
    this.#error.dataset.kind = "error";
    this.#warning.dataset.kind = "warning";
    this.#messages.append(this.#help, this.#error, this.#warning);
    this.#fieldsElement.style.display = "grid";
    this.#fieldsElement.style.gap = "6px";
    this.#body.style.display = "grid";
    this.#body.style.gap = "6px";
    this.#body.append(this.#controls, this.#messages, this.#fieldsElement, this.#childrenElement);
    this.element.append(this.#summary, this.#body);
  }

  public get label(): string {
    return this.#node?.label ?? this.path[this.path.length - 1] ?? "";
  }

  public update(
    node: Node,
    reorder?: { up?: string; down?: string; parent: readonly string[] },
  ): void {
    this.#node = node;
    if (!this.#initialized) {
      this.element.open = node.defaultExpansionState !== "collapsed";
      this.#initialized = true;
    }
    const label = this.label;
    this.element.setAttribute("aria-label", label);
    this.#labelText.textContent = label;
    this.#swatch.hidden = node.color == undefined;
    this.#swatch.style.background = node.color ?? "";

    this.#visibleLabel.hidden = node.visible == undefined;
    this.#visible.checked = node.visible === true;
    this.#visible.setAttribute("aria-label", `Show ${label}`);

    this.#rename.hidden = node.renamable !== true;
    this.#rename.setAttribute("aria-label", `Rename ${label}`);
    setInputValue(this.#rename, label);

    const actionButtons: HTMLButtonElement[] = [];
    for (const action of node.actions ?? []) {
      if (action.type !== "action") {
        continue;
      }
      const button = element("button", {
        type: "button",
        textContent: action.label,
        disabled: action.disabled === true,
      });
      const tooltip = (action as { tooltip?: string }).tooltip;
      if (tooltip != undefined) {
        button.title = tooltip;
      }
      button.addEventListener("click", () => {
        this.dispatch({
          action: "perform-node-action",
          payload: { id: action.id, path: this.path },
        });
      });
      actionButtons.push(button);
    }
    if (reorder?.up != undefined) {
      actionButtons.push(
        this.#reorderButton(`Move ${label} up`, reorder.parent, reorder.up, "before"),
      );
    }
    if (reorder?.down != undefined) {
      actionButtons.push(
        this.#reorderButton(`Move ${label} down`, reorder.parent, reorder.down, "after"),
      );
    }
    this.#actions.replaceChildren(...actionButtons);

    setText(this.#help, node.help);
    setText(this.#error, node.error == undefined ? undefined : `Error: ${node.error}`);
    setText(
      this.#warning,
      node.error == undefined && node.warning != undefined ? `Warning: ${node.warning}` : undefined,
    );

    const fieldElements: Element[] = [];
    const seenFields = new Set<string>();
    for (const [key, field] of Object.entries(node.fields ?? {})) {
      if (field == undefined) {
        continue;
      }
      seenFields.add(key);
      let view = this.#fields.get(key);
      if (view == undefined || view.input !== field.input) {
        view = new FieldView([...this.path, key], field, this.dispatch);
        this.#fields.set(key, view);
      } else {
        view.update(field);
      }
      fieldElements.push(view.element);
    }
    for (const key of [...this.#fields.keys()]) {
      if (!seenFields.has(key)) {
        this.#fields.delete(key);
      }
    }
    syncChildren(this.#fieldsElement, fieldElements);

    const children = orderedChildren(node);
    const reorderable =
      node.childrenReorderable != undefined && node.childrenReorderable !== false
        ? children.filter(([, child]) => child.reorderable !== false).map(([key]) => key)
        : [];
    const childElements: Element[] = [];
    const seenChildren = new Set<string>();
    for (const [key, child] of children) {
      seenChildren.add(key);
      let view = this.#children.get(key);
      if (view == undefined) {
        view = new NodeView([...this.path, key], this.dispatch);
        this.#children.set(key, view);
      }
      const index = reorderable.indexOf(key);
      view.update(
        child,
        reorderable.length >= 2 && index !== -1
          ? { up: reorderable[index - 1], down: reorderable[index + 1], parent: this.path }
          : undefined,
      );
      childElements.push(view.element);
    }
    for (const key of [...this.#children.keys()]) {
      if (!seenChildren.has(key)) {
        this.#children.delete(key);
      }
    }
    syncChildren(this.#childrenElement, childElements);
  }

  /** Hides what does not match `filter`, and returns whether anything in this node matched */
  public applyFilter(filter: string): boolean {
    const selfMatches = filter === "" || this.label.toLowerCase().includes(filter);
    let anyMatch = selfMatches;
    for (const field of this.#fields.values()) {
      const fieldMatches = selfMatches || field.label.toLowerCase().includes(filter);
      field.element.hidden = !fieldMatches;
      anyMatch ||= fieldMatches;
    }
    for (const child of this.#children.values()) {
      const childMatches = child.applyFilter(selfMatches ? "" : filter);
      anyMatch ||= childMatches;
    }
    this.element.hidden = !anyMatch;
    return anyMatch;
  }

  public child(key: string): NodeView | undefined {
    return this.#children.get(key);
  }

  #reorderButton(
    name: string,
    parent: readonly string[],
    toKey: string,
    position: "before" | "after",
  ): HTMLButtonElement {
    const button = element("button", { type: "button", textContent: name });
    button.addEventListener("click", () => {
      this.dispatch({
        action: "reorder-children",
        payload: { path: parent, fromKey: this.path[this.path.length - 1]!, toKey, position },
      });
    });
    return button;
  }

  #sendUpdate(path: readonly string[], input: "string" | "boolean", value: string | boolean): void {
    this.dispatch({ action: "update", payload: { path, input, value } } as SettingsTreeAction);
  }
}

/**
 * A settings sidebar for one panel. It shows the panel's settings tree as plain form controls,
 * with the labels, values, and actions from the tree, and sends the panel the same actions that
 * Foxglove's settings sidebar sends when a user edits them.
 */
export class SettingsEditor {
  public readonly element = element("section");
  readonly #heading = element("h2");
  readonly #filter = element("input", { type: "search" });
  readonly #nodesElement = element("div");
  readonly #roots = new Map<string, NodeView>();
  #focusedPath: readonly string[] | undefined;

  public constructor(dispatch: Dispatch) {
    this.element.style.display = "grid";
    this.element.style.gap = "8px";
    this.#heading.style.fontSize = "1em";
    this.#heading.style.margin = "0";
    this.#filter.setAttribute("aria-label", "Filter settings");
    this.#filter.placeholder = "Filter";
    this.#filter.addEventListener("input", () => {
      this.#applyFilter();
    });
    this.#nodesElement.style.display = "grid";
    this.#nodesElement.style.gap = "8px";
    this.element.append(this.#heading, this.#filter, this.#nodesElement);
    this.#dispatch = dispatch;
    this.update("Panel", undefined);
  }

  readonly #dispatch: Dispatch;

  public update(title: string, tree: Immutable<SettingsTree> | undefined): void {
    this.element.setAttribute("aria-label", `${title} settings`);
    this.#heading.textContent = `${title} settings`;
    this.#filter.hidden = tree?.enableFilter !== true;

    const rootElements: Element[] = [];
    const seen = new Set<string>();
    for (const [key, node] of Object.entries(tree?.nodes ?? {})) {
      if (node == undefined) {
        continue;
      }
      seen.add(key);
      let view = this.#roots.get(key);
      if (view == undefined) {
        view = new NodeView([key], this.#dispatch);
        this.#roots.set(key, view);
      }
      view.update(node);
      rootElements.push(view.element);
    }
    for (const key of [...this.#roots.keys()]) {
      if (!seen.has(key)) {
        this.#roots.delete(key);
      }
    }
    syncChildren(this.#nodesElement, rootElements);
    this.#applyFilter();

    const focusedPath = tree?.focusedPath;
    if (focusedPath != undefined && focusedPath !== this.#focusedPath) {
      let node = this.#roots.get(focusedPath[0] ?? "");
      for (const key of focusedPath.slice(1)) {
        node = node?.child(key);
      }
      if (node != undefined) {
        node.element.open = true;
        node.element.scrollIntoView({ block: "nearest" });
      }
    }
    this.#focusedPath = focusedPath;
  }

  #applyFilter(): void {
    const filter = this.#filter.hidden === true ? "" : this.#filter.value.trim().toLowerCase();
    for (const root of this.#roots.values()) {
      root.applyFilter(filter);
    }
  }
}

/** Find the node at `path` in `tree` */
export function findNode(tree: Immutable<SettingsTree>, path: readonly string[]): Node | undefined {
  let node: Node | undefined = tree.nodes[path[0] ?? ""];
  for (const key of path.slice(1)) {
    node = node?.children?.[key];
  }
  return path.length === 0 ? undefined : node;
}

/**
 * The input type of the setting at `path`, the way the settings sidebar would send it, or an
 * explanation of why the setting cannot be edited.
 */
export function settingInput(
  tree: Immutable<SettingsTree>,
  path: readonly string[],
  value: unknown,
): { input: string; value: unknown } | { error: string } {
  const key = path[path.length - 1];
  const node = findNode(tree, path.slice(0, -1));
  const where = `[${path.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (key == undefined || node == undefined) {
    return { error: `There is no settings node at ${where}` };
  }
  const field = node.fields?.[key];
  if (field != undefined) {
    if (field.disabled === true) {
      return { error: `The setting at ${where} is disabled` };
    }
    if (field.readonly === true) {
      return { error: `The setting at ${where} is read-only` };
    }
    const problem = invalidValue(field, value);
    return problem == undefined
      ? { input: field.input, value: normalizeValue(field, value) }
      : { error: `The settings sidebar cannot set ${where} to ${describe(value)}: ${problem}` };
  }
  if (key === "label" && node.renamable === true) {
    return typeof value === "string"
      ? { input: "string", value }
      : { error: `The label at ${where} must be a string` };
  }
  if (key === "visible" && node.visible != undefined) {
    return typeof value === "boolean"
      ? { input: "boolean", value }
      : { error: `The visibility at ${where} must be true or false` };
  }
  return { error: `There is no setting at ${where}` };
}

/** The limits of a number or vector field */
interface NumberBounds {
  readonly min?: number;
  readonly max?: number;
  readonly precision?: number;
}

/**
 * Like Foxglove's number inputs, keep a number within the field's minimum and maximum, and round it
 * to the field's precision
 */
function normalizeNumber(value: number, field: NumberBounds): number {
  let result = value;
  if (field.min != undefined) {
    result = Math.max(result, field.min);
  }
  if (field.max != undefined) {
    result = Math.min(result, field.max);
  }
  if (field.precision != undefined) {
    const scale = 10 ** field.precision;
    result = Math.round(result * scale) / scale;
  }
  return result;
}

/** The value the settings sidebar would send for `value`, which only changes numbers */
function normalizeValue(field: Field, value: unknown): unknown {
  if (field.input === "number" && typeof value === "number") {
    return normalizeNumber(value, field);
  }
  if ((field.input === "vec2" || field.input === "vec3") && Array.isArray(value)) {
    return value.map((item: unknown) =>
      typeof item === "number" ? normalizeNumber(item, field) : item,
    );
  }
  return value;
}

function describe(value: unknown): string {
  try {
    return value === undefined ? "undefined" : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function optionValues(options: readonly unknown[]): unknown[] {
  return options.map((option) =>
    typeof option === "object" && option != undefined
      ? (option as { value: unknown }).value
      : option,
  );
}

/** Why the settings sidebar could not send `value` for `field`, or undefined if it could */
function invalidValue(field: Field, value: unknown): string | undefined {
  const isNumber = (item: unknown) => typeof item === "number" && Number.isFinite(item);
  switch (field.input) {
    case "string":
    case "multiline-string":
    case "messagepath":
    case "autocomplete":
    case "rgb":
    case "rgba":
      return value === undefined || typeof value === "string" ? undefined : "it takes a string";
    case "boolean":
      return typeof value === "boolean" ? undefined : "it takes true or false";
    case "number": {
      if (value === undefined) {
        return undefined;
      }
      return isNumber(value) ? undefined : "it takes a number";
    }
    case "select": {
      const options = field.options as readonly { value: unknown; disabled?: boolean }[];
      const allowed = options
        .filter((option) => option.disabled !== true)
        .map((option) => option.value);
      const values: readonly unknown[] = Array.isArray(field.value)
        ? Array.isArray(value)
          ? (value as readonly unknown[])
          : [Symbol("not an array")]
        : [value];
      return values.every((item) => allowed.includes(item))
        ? undefined
        : "it is not one of the enabled options";
    }
    case "toggle":
      return optionValues(field.options).includes(value)
        ? undefined
        : "it is not one of the options";
    case "gradient":
      return Array.isArray(value) &&
        value.length === 2 &&
        value.every((item) => typeof item === "string")
        ? undefined
        : "it takes two color strings";
    case "vec2":
    case "vec3": {
      const size = field.input === "vec2" ? 2 : 3;
      return Array.isArray(value) &&
        value.length === size &&
        value.every((item) => item === undefined || isNumber(item))
        ? undefined
        : `it takes ${size} numbers`;
    }
  }
}
