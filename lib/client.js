window.__ModuleLoader__.load({
	id: "dsh-public",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// Some engines return an empty hostname for dsh-resource://file/..., so the
		// official file provider never matches and the sidebar stays on
		// "文件资源服务不可用". Only those engines get a URL wrapper.
		const win = window;
		let result = "no-url";
		if (typeof win.URL === "function") {
			const NativeURL = win.URL;
			let probe;
			try {
				probe = new NativeURL("dsh-resource://file/__dsh_probe__/x");
			} catch {
				result = "probe-throw";
			}
			if (result !== "probe-throw") {
				if (probe.hostname === "file") result = "not-needed";
				else {
					const hostOf = (raw) => {
						const matched = /^dsh-resource:\/\/([^/?#]*)/i.exec(String(raw || ""));
						return matched && matched[1] ? matched[1].toLowerCase() : "";
					};
					function CompatURL(...args) {
						const url = new NativeURL(...args);
						try {
							if (String(url.protocol) === "dsh-resource:" && !url.hostname) {
								const proto = NativeURL.prototype;
								const hostnameDesc = Object.getOwnPropertyDescriptor(proto, "hostname");
								const hostDesc = Object.getOwnPropertyDescriptor(proto, "host");
								const hostOfUrl = (current) => {
									let native = "";
									try {
										native = hostnameDesc && hostnameDesc.get ? hostnameDesc.get.call(current) : (current.hostname || "");
									} catch {
										native = "";
									}
									if (native) return native;
									let href = "";
									try { href = String(current.href); } catch { href = ""; }
									return hostOf(href);
								};
								if (hostOfUrl(url)) {
									Object.defineProperty(url, "hostname", {
										configurable: true,
										enumerable: hostnameDesc ? hostnameDesc.enumerable : true,
										get: () => hostOfUrl(url),
										set: (value) => { if (hostnameDesc && hostnameDesc.set) hostnameDesc.set.call(url, value); },
									});
									if (hostDesc) {
										Object.defineProperty(url, "host", {
											configurable: true,
											enumerable: hostDesc.enumerable,
											get: () => hostOfUrl(url),
											set: (value) => { if (hostDesc.set) hostDesc.set.call(url, value); },
										});
									}
								}
							}
						} catch { /* keep the native URL */ }
						return url;
					}
					CompatURL.prototype = NativeURL.prototype;
					for (const key of Object.getOwnPropertyNames(NativeURL)) {
						if (key === "length" || key === "name" || key === "prototype") continue;
						try { CompatURL[key] = NativeURL[key]; } catch { /* ignore read-only statics */ }
					}
					win.URL = CompatURL;
					result = "installed";
				}
			}
		}
		win.__dshResourceUrlCompat = result;

		exports.inject = [];
		exports.apply = () => {};
		return module.exports;
	},
});
