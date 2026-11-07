# Distributing TiinyPaint

As of 2026-11-07. This comes from the public documentation, the device API and TiinyOS 0.1.39. Nothing was installed on the Tiiny.

## Recommendation

**Keep the web page as the single product, and publish it first on the community App Farm with a small launcher.** Write to Tiiny in parallel about access to the official store, and only wrap it in a desktop app if there is a real need.

All the heavy computation already runs on the NPU, and everything else in the browser. Hosting the page on the Tiiny would only serve static files.

## The two "stores"

### Official Tiiny Agent Store

**Open to third parties: no public procedure found.** There is no form, no publishing guide in [dev.tiiny.ai](https://dev.tiiny.ai) and no submission route. This does not prove that none exists on request: Tiiny needs to be asked.

What can be seen on the device:
- A catalog served by Tiiny through `/api/v1/apps`: extensions, desktop apps as archives, and webapps.
- Webapps: **ARM64 Docker Compose services** pulled from `registry.tiiny.cloud`, listed by `/api/services`, each with its own port.
- **Tiinyvisuals**, image `tiiny-image` v0.1.22, is an official webapp of this type. It is a direct competitor worth examining.

Route for installing an arbitrary Compose file: the documentation does not show one (list, download status, cancel, delete). Not tested, to avoid changing the device.

### tiinyapp.farm (community)

[tiinyapp.farm](https://tiinyapp.farm) is **open to apps, but not affiliated with Tiiny** (Titanium Computing). It has 10 apps in its catalog, including one named `image-studio`, another competitor to look at.

- Apps run **on the PC, alongside the Tiiny**. Nothing is installed on the device.
- Publishing: proof of owning a Tiiny (a code placed in the TiinyVerse bio), a `.tar.gz` archive, `farm.json`, and the `farm publish` command.
- Automated checks, then **mandatory human review**. Forbidden: `subprocess`, `ctypes`, `eval`, secrets in the archive. Upload limit: 50 MB.
- Installation: `pip install tiinyapp-farm`, then `farm install` and `farm start`. Requires Python 3.9 or later.

Needed for TiinyPaint: a Python launcher of a few lines (`http.server`, `network` and `device` permissions) and a `farm.json`. The farm passes the address and key through the environment, so the launcher will have to pass them to the page.

## Comparison

| | Local page (current) | App Farm | On the Tiiny | Desktop (Tauri, like Tiiny Studio) |
|---|---|---|---|---|
| Available today | Yes | After review | **No, no public route found** | After packaging |
| Installation | None | Python + `farm` | One click if accepted in the store | An installer |
| User discovery | None | Community catalog | **The best** | Up to us |
| Access from phone or tablet | No | No | **Yes, on the local network** | No |
| USB access | Yes | Yes | To be checked: app ports seem to be blocked over USB | Yes |
| Tiiny memory used | None | None | One more container | None |
| Image storage | PC | PC | On the Tiiny, can be shared between devices | PC, with file access |
| Effort | Done | Low | High: ARM64 image, registry, updates | Medium: build and signing per OS |
| Dependency on Tiiny | API only | API only | **Strong**: acceptance and registry | API only |
| Code reused | All | All, plus a launcher | All, plus a container | All, plus a wrapper |

Tiiny Studio is itself a community Tauri app (`io.github.thezolon.tiinystudio`), not an official product. A desktop app therefore needs no authorization.

## To settle before any public release

1. **Licenses**: Qwen-Image 2.1, PE-I2I and PE-T2I are under the [Qwen research license](../licenses/QWEN_RESEARCH_LICENSE.txt): non-commercial use only, unless separately agreed. Redistribution is allowed with the license and a `Notice` statement, both provided in this repo for `web/prompts.js`. A paid version would need that agreement. Downloading the prompts at first launch would avoid redistributing them, but would not lift the usage limit on the models.
2. **Addresses**: the Tiiny address is entered by hand. Discovery would be better (`:39218/device.json`, or the `api.tiiny` names).

## Questions for Tiiny

- Is there a route for publishing a third-party webapp to the store?
- Could a route for previewing the x0 estimate during diffusion be considered?
- Are the `stream_return_steps` parameter and the streaming route stable? They do not appear in any documentation we have found.
- A community model can declare 0% NPU, which skews `unload_candidate`: is this a known issue?
