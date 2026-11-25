// A small navigator: four tabs, each with its own stack. Pure reducer so back behaviour is testable;
// Android's back button pops the current tab's stack, then returns to the Boutique tab, then exits.
export type Tab = "boutique" | "design" | "favorites" | "profile";
export const TABS: Tab[] = ["boutique", "design", "favorites", "profile"];
export type Route =
  | { name: "catalog" } | { name: "favorites" } | { name: "profile" } | { name: "product"; id: string }
  | { name: "designs" } | { name: "newDesign" } | { name: "editor"; id: string }
  | { name: "quote"; revisionId: string } | { name: "order"; id: string };
export interface NavState { tab: Tab; stacks: Record<Tab, Route[]> }
export type NavAction = { type: "tab"; tab: Tab } | { type: "push"; route: Route } | { type: "replace"; route: Route } | { type: "back" };

const ROOT: Record<Tab, Route> = { boutique: { name: "catalog" }, design: { name: "designs" }, favorites: { name: "favorites" }, profile: { name: "profile" } };
export const initialNav: NavState = {
  tab: "boutique", stacks: { boutique: [ROOT.boutique], design: [ROOT.design], favorites: [ROOT.favorites], profile: [ROOT.profile] },
};

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case "tab":
      // Tapping the current tab again returns it to its root, as platform tab bars do.
      if (action.tab === state.tab) return { ...state, stacks: { ...state.stacks, [state.tab]: [ROOT[state.tab]] } };
      return { ...state, tab: action.tab };
    case "replace": // e.g. the new-design form becomes the editor, so back does not reopen the form
      return { ...state, stacks: { ...state.stacks, [state.tab]: [...state.stacks[state.tab].slice(0, -1), action.route] } };
    case "push":
      return { ...state, stacks: { ...state.stacks, [state.tab]: [...state.stacks[state.tab], action.route] } };
    case "back": {
      const stack = state.stacks[state.tab];
      if (stack.length > 1) return { ...state, stacks: { ...state.stacks, [state.tab]: stack.slice(0, -1) } };
      if (state.tab !== "boutique") return { ...state, tab: "boutique" };
      return state;
    }
  }
}

export const currentRoute = (s: NavState): Route => s.stacks[s.tab][s.stacks[s.tab].length - 1];
/** True when back has somewhere to go inside the app; false lets Android close it. */
export const canGoBack = (s: NavState): boolean => s.stacks[s.tab].length > 1 || s.tab !== "boutique";
