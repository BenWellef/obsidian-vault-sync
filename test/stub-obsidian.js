// Minimal stand-in so the modules under test can be bundled for Node.
// Only the shapes that are imported as values need to exist.
export class App {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export class DataAdapter {}
export function requestUrl() {
	throw new Error("requestUrl is not available in tests");
}
