# Third-party licences

nexdiary itself is licensed under the **GNU Affero General Public License v3.0** (see [LICENSE](LICENSE)). This file
lists what it ships or depends on.

## Bundled with the app

These files travel inside the container image, so their notices travel with them.

| What | Copyright | Licence | Notice in the app |
|---|---|---|---|
| Fonts Fraunces, Lora and Nunito (via Fontsource) | The Fraunces, Lora and Nunito Project Authors | OFL-1.1 | `/licenses/fonts.txt` |
| Lucide icons (partly from Feather) | Lucide Contributors; Cole Bemis | ISC, MIT | `/licenses/lucide.txt` |

nexdiary loads no font, icon or script from another host.

## Backend

What `backend/requirements.txt` names, and what those packages bring along (checked against the installed set, which is
what the container image installs; on Linux `uvicorn[standard]` adds uvloop).

| Package | Licence |
|---|---|
| FastAPI, Starlette (the web framework), SQLAlchemy, pydantic, pydantic-core, pydantic-settings, annotated-types, annotated-doc, typing-inspection | MIT, Starlette BSD-3-Clause |
| anyio, h11, httptools, watchfiles, PyYAML, PyJWT, http-ece | MIT |
| argon2-cffi, argon2-cffi-bindings, cffi | MIT (cffi: MIT-0 for its own part) |
| uvicorn, httpx, httpcore, click, idna, segno, python-dotenv, websockets, pycparser | BSD-3-Clause |
| uvloop (Linux only) | MIT **or** Apache-2.0 |
| Pillow | MIT-CMU |
| cryptography | Apache-2.0 **or** BSD-3-Clause |
| tzdata (the IANA time zone database for Python) | Apache-2.0; the data itself is in the public domain |
| typing-extensions | PSF-2.0 |
| SQLite (the library inside Python) | Public domain |
| certifi (the CA bundle) | MPL-2.0; the file is unchanged and its source is public |
| pillow-heif | BSD-3-Clause for its own code; the binary wheels are **GPLv2** as a whole, see below |
| webauthn (py_webauthn, passkeys) | BSD-3-Clause |
| cbor2 | MIT |
| pyOpenSSL | Apache-2.0 |
| pyasn1, pyasn1-modules | BSD-2-Clause, BSD-3-Clause |

### HEIC photos: pillow-heif and the libraries it brings

To read iPhone photos (HEIC), as a profile picture or a photo of a day, nexdiary uses pillow-heif. Its binary wheels, and so the container
image, contain:

| Library | Licence |
|---|---|
| libheif | LGPL-3.0 |
| libde265 | LGPL-3.0 |
| x265 | GPL-2.0-or-later |

The wheel ships these notices in `pillow_heif-*.dist-info/licenses/`. GPL-2.0-or-later and LGPL-3.0 may be combined
with an AGPL-3.0 work, and the source of every part is public.

## Frontend

| Package | Licence |
|---|---|
| React, React DOM, React Router, i18next, react-i18next | MIT |
| lucide-react | ISC |
| Milkdown (`@milkdown/kit`), ProseMirror, remark, unified, micromark (the editor and what it brings) | MIT |
| Fontsource packages | MIT (the fonts themselves OFL-1.1, see above) |

The editor package also installs a few packages for parts of Milkdown that nexdiary does not use (such as DOMPurify,
MPL-2.0 or Apache-2.0, and Vue, MIT). The build leaves them out: they are not in the image.

Build and test tools (Vite, TypeScript, Tailwind CSS, Vitest, ruff, pytest) are not part of the image.

## Compatibility

All of the above may be combined into an AGPL-3.0 work. The obligation runs one way: nexdiary as a whole is
AGPL-3.0, and anyone who runs a modified version as a network service must offer its source.
