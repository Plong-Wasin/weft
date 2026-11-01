# The web UI reproduces Plane's look and behaviour but copies none of its code

Weft's web app must look and behave like Plane (layout, tokens, spacing, interactions). Plane is licensed AGPL-3.0 and its design components come from the `@makeplane/propel` package; Weft has no license file yet. We reproduce Plane's visible design (token values, structure, interactions) in components written for Weft, do not copy Plane source files, and do not install `@makeplane/propel`. Data fetching stays on TanStack Query over the Action registry; we do not adopt Plane's MobX stores.

We rejected copying Plane's components (fast, but it would force the AGPL onto Weft and tie us to Plane's release cadence) and a loose "Plane-like" skin (the state before this decision: nobody could tell the product apart from a generic form shell). If Weft is later released under AGPL-3.0, this decision can be revisited.
