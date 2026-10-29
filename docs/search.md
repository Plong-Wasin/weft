# Task search

`GET /api/v1/workspaces/{workspace_id}/search?q=...&page=1&limit=20` searches task numbers, titles, descriptions, active comment bodies, and JSON Attribute values with PostgreSQL `ILIKE` substring matching. Task number matches are exact. Queries must contain 1–100 Unicode characters; pages start at 1 and limits range from 1 to 50.

Search and count queries apply Workspace membership and Project visibility/grants in PostgreSQL before selecting result text. Restricted Projects therefore do not contribute results or counts. Search does not split Thai text into words: an exact Thai sequence and any contiguous substring of it match. This is covered by `comments_search_export` tests for Thai title substring and Attribute value matching.
