#!/usr/bin/env bun
import { main } from "./program";

process.exitCode = await main(process.argv);
