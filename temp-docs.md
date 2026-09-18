# File System WebSocket API

Two WebSocket message pairs for browsing the selected repo's directory tree and reading file contents. A repo must be selected first (via `select_repo`) before using either of these.

---

## `list_dir` → `dir_listing`

Browse the directory tree. Path defaults to the repo root if omitted.

**Send:**
```json
{ "type": "list_dir", "path": "/absolute/path/to/dir" }
```
- `path` — optional; defaults to the repo root if omitted
- Must be an absolute path inside the selected repo (path traversal is rejected)

**Receive:**
```json
{
  "type": "dir_listing",
  "path": "/absolute/path/to/dir",
  "entries": [
    { "name": "src",          "path": "/abs/.../src",          "type": "directory", "size": null },
    { "name": "package.json", "path": "/abs/.../package.json", "type": "file",      "size": 1234 }
  ]
}
```
- `entries` — sorted: directories first (alphabetical), then files (alphabetical)
- All files including dotfiles are included
- `size` is `null` for directories, byte count for files

**On error:**
```json
{ "type": "error", "message": "..." }
```

---

## `read_file` → `file_content`

Read the full UTF-8 contents of a file.

**Send:**
```json
{ "type": "read_file", "path": "/absolute/path/to/file.ts" }
```
- `path` — required; must be an absolute path inside the selected repo

**Receive:**
```json
{
  "type": "file_content",
  "path": "/absolute/path/to/file.ts",
  "content": "... full file text ...",
  "size": 4321
}
```
- `content` — full file text as a UTF-8 string
- `size` — file size in bytes

**On error:**
```json
{ "type": "error", "message": "..." }
```
- Files larger than 5 MB return an error
- Paths outside the selected repo return an error

---

## Error cases (both messages)

| Condition | Error message |
|-----------|---------------|
| No repo selected | `"No repo selected"` |
| `path` outside repo root | `"Path is outside the selected repository"` |
| File exceeds 5 MB | `"File exceeds 5 MB limit (N bytes)"` |
| `read_file` missing `path` | `"read_file requires a path"` |
| `readdir` / `stat` / `readFile` OS error | forwarded error message |
