# Weft — Product & Technical Specification

**Version:** 0.4 · AI-first: Height 1.0 + GitHub-style work management + Knowledge, Teams และ Mobile-first
**Date:** 29 October 2026
**Repository:** `weft`
**Tagline:** Open-source, self-hosted project management for teams. Built with Rust.

## 1. Product direction and scope

Weft เป็นระบบจัดการงานแบบ Self-hosted และ Open source ใช้ Rust เป็นฐาน เน้นความคล่องตัวของ Height 1.0 ผสมกับความชัดเจนของ Issue discussion และ Task references แบบ GitHub โดยไม่เชื่อม Git repository และใช้ AI transformation เป็นหลักในการออกแบบ ตั้งแต่การรับเป้าหมาย วางแผน แตกงาน เชื่อมงาน ลงมือจัดการ และติดตามผล

เอกสารนี้กำหนดพฤติกรรมของ Weft ไม่ใช่การยืนยันรายละเอียดทุกฟีเจอร์ของ Height ในอดีต โดยเฉพาะ Undo และการยุบ History เป็นข้อกำหนดตามประสบการณ์และความต้องการของผู้ใช้

v0.4 เพิ่ม **Knowledge** (โน้ต Markdown/HTML ใน Vault ที่ใช้ git ภายในเป็นที่เก็บเวอร์ชัน ผู้ใช้ไม่แก้โน้ตตรง ๆ แต่ให้ AI เสนอแล้ว Approve), **Team**, **Skill** ที่สอนระบบให้ AI และออกแบบเป็น **mobile-first PWA** รวมทั้งกำหนดว่าทุกการเขียนโดย AI ต้องผ่าน Proposal ที่คนกด Approve ครั้งเดียว

### ข้อกำหนดที่ยืนยัน

- AI-first work management และ Collaboration เป็นแกนหลัก; AI เป็นช่องทางทำงานกับระบบทั้งชุด ไม่ใช่แค่ Chatbot ข้างบอร์ด
- รองรับ Claude Code และ Codex ผ่าน Subscription ตาม Capability/เงื่อนไขผู้ให้บริการ พร้อม API-key mode เป็นทางเลือกแยก
- MUST มี Global AI connection ที่ผู้ดูแลตั้งครั้งเดียวแล้วสมาชิกที่ได้รับอนุญาตใช้ AI กลางเดียวกันได้ โดยยังมี Personal connection เป็นทางเลือก
- ผู้ใช้สร้างหรือเปิด Task จากคำสั่งภาษาธรรมชาติ ให้ AI เสนอแตกงาน และเชื่อม Parent/Related/Dependency ได้
- Full keyboard operation เป็น Release requirement ไม่ใช่ฟีเจอร์เสริม
- ผู้ใช้เพิ่ม Status และ Attributes เองได้ตั้งแต่ Core alpha
- ทุกการแก้ Task ที่มีผลจริงมี History ที่อ่านได้ พร้อม Actor, เวลา และค่าเดิม/ใหม่
- Undo/Redo และการแก้กลับค่าเดิมต้องทำให้ Timeline สะท้อนผลสุทธิ ไม่เหลือ Log รบกวนของการแก้ที่ถูกย้อนแล้ว
- อ้างถึง Task อื่นด้วย `#123`, Autocomplete และ Backlinks แบบ GitHub ได้
- Frontend, API, WebSocket และไฟล์แนบใช้ Public domain เดียวกัน
- ติดตั้งด้วย Docker; ไฟล์เกี่ยวกับ Docker อยู่ในโฟลเดอร์ `docker/`
- มี Table, Kanban, Smart Lists, Task chat, Inbox, Projects และ Milestones
- Knowledge: หนึ่ง Vault คือ git repo ภายในหนึ่งอัน (ตรงกับ vault ของ Obsidian หนึ่งอัน) เฉพาะ Weft เป็นผู้ commit; ผู้ใช้ไม่แก้โน้ตตรง ๆ แต่สั่ง AI ให้เสนอการแก้เป็น Proposal แล้วกด Approve; รองรับ Markdown แบบ Obsidian และ HTML
- ทุกการเขียนโดย AI (Task, ความสัมพันธ์, โน้ต, ไฟล์, Skill, Schema) อยู่ใน Proposal เดียวที่เตรียมครบแล้ว Approve ครั้งเดียว; AI ไม่มีสิทธิ์เขียนหรือ Apply เอง และไม่มี Pre-authorized policy
- Team เป็นกลุ่มผู้ใช้ที่ไม่มี role; Task มี Assignee ได้หลายรายการ (ผู้ใช้หรือ Team)
- Skill ระดับ Workspace สอน AI เรื่องระบบและวิธีทำงาน แก้บนเว็บได้ ไม่ให้สิทธิ์เพิ่ม
- Mobile-first PWA (ติดตั้งได้ ไม่ใช่ native app) พร้อม Full keyboard บน Desktop

### สิ่งที่ตัดออกจาก Roadmap ฉบับนี้

- GitHub/GitLab repository integration, Pull request sync, Commit hooks และ Code hosting; Git ใช้เป็นที่เก็บเวอร์ชันภายในของ Vault เท่านั้น ส่วนการส่ง Vault ขึ้น git host ภายนอกและการ clone แบบอ่านอย่างเดียวเลื่อนเป็นงานอนาคต
- ไม่ทำ Height 2.0 clone; AI ของ Weft ออกแบบตาม Workflow ในเอกสารนี้ ไม่อ้างว่าคัดลอกพฤติกรรมเดิม
- การแก้โน้ตโดยผู้ใช้โดยตรง (ไม่มี Markdown editor), Real-time collaborative editing ของโน้ต และการแสดง Obsidian Canvas/Dataview/ปลั๊กอินบนเว็บ
- Marketplace, Billing, Federation, Native mobile apps และการเขียนแบบ Offline (PWA แคชเพื่ออ่านได้ ไม่เขียน)
- External webhooks, Git connectors และ General-purpose automation engine อยู่นอก Roadmap; เพิ่ม Scoped Weft tools/MCP สำหรับ AI โดยเฉพาะในขอบเขตปัจจุบัน

GitHub ในเอกสารนี้หมายถึงแนวคิดด้าน Issue UX: รหัสงาน, Markdown, References, Backlinks, Discussion และ Activity ไม่ใช่การเชื่อมต่อ GitHub

AI เป็นส่วนสำคัญของ Product roadmap แต่ Core tasks ต้องยังเปิดอ่าน/แก้ได้เมื่อ Provider ล่มหรือผู้ใช้ยังไม่เชื่อมบัญชี AI

### ข้อเสนอทางเทคนิคที่ยังปรับได้

- Rust + Axum + Tokio สำหรับ Backend/Worker และ React + TypeScript สำหรับหน้าเว็บ
- PostgreSQL เป็นแหล่งข้อมูลหลัก; Modular monolith ก่อน Microservices
- ใช้ Local attachment volume เริ่มต้น ไม่บังคับ Redis/S3/SMTP/Cloud services
- Knowledge ใช้ `git` CLI + `git-lfs` ภายใน image (worktree ต่อ Vault), comrak สำหรับ parse Markdown ฝั่ง server และ Postgres full-text + `pg_trgm` สำหรับค้นหา
- หนึ่ง Installation มีหลาย Workspace; Mobile-first PWA (ติดตั้งได้ ไม่ใช่ native app) ขยายเป็น Desktop พร้อม Full keyboard
- License เสนอ AGPL-3.0-only; ต้องยืนยันและเพิ่ม LICENSE ก่อนเผยแพร่ Repo
- เป้าหมายแรก 5–30 คน เริ่มวัดการขยายถึงประมาณ 100 Active users

## 2. หลักการและสิ่งที่หยิบมารวมกัน

| แรงบันดาลใจ | พฤติกรรมที่ Weft ต้องมี |
|---|---|
| Height: แก้งานเร็ว | Inline edits, Bulk actions, Command palette และ Keyboard navigation |
| Height: หลายมุมมอง | Task เดียวอยู่หลาย List และสลับ Table/Kanban ได้ |
| Height: คุยในบริบท | Task chat, Files, Watchers และ Inbox |
| Height ตามความต้องการผู้ใช้: History ที่ไม่รก | Undo/Redo และการยุบการแก้กลับเป็นค่าเดิม |
| Height: ปรับวิธีทำงาน | Custom statuses, Custom attributes และ Smart Lists |
| GitHub Issues: อ้างอิงชัดเจน | `#number`, Stable URLs และ Backlinks |
| GitHub Issues: Discussion | Markdown, @mentions, Reactions, Quote/reply และ Timeline |
| Self-hosting | Domain เดียว, Docker, Backup/Restore และไม่ต้องมีบริการกลางสำหรับ Core |
| AI transformation | Goal → Proposal → Tasks/Links → Execution support → Progress review ผ่าน Claude Code หรือ Codex |
| Knowledge | โน้ตแบบ Obsidian ใน Vault (git ภายใน) ที่ AI อ่านได้ แก้ผ่าน Proposal และแสดงบนเว็บ |
| Mobile-first | PWA ที่ออกแบบจากหน้าจอเล็กก่อน; ตรวจและ Approve Proposal ได้บนมือถือ |

### เป้าหมาย UX

- สร้างงานได้เร็วเหมือนพิมพ์รายการในเอกสาร
- อ่าน Task แล้วเข้าใจทั้งสถานะ บทสนทนา และเหตุผลที่เปลี่ยน
- การย้อนความผิดพลาดเป็นงานปกติที่ทำได้ง่าย
- ทุกฟังก์ชันที่ใช้ Mouse ต้องมี Keyboard equivalent ที่หาเจอได้
- ข้อมูลจริงมีชุดเดียว ไม่แยก Task copy ตาม View
- AI ใช้ Domain commands, ACL, History และ Undo ชุดเดียวกับ UI
- คำสั่งเดียวสร้างแผนงานได้ แต่ผู้ใช้ยังตรวจ แก้ และเลือกนำไปใช้บางส่วนได้
- AI ไม่เขียนข้อมูลเอง: ทุกการเปลี่ยนแปลงอยู่ใน Proposal เดียวที่เตรียมครบ แล้วคนกด Approve ครั้งเดียว
- คนที่ไม่รู้จัก git ใช้ Knowledge ได้ (git อยู่ข้างหลัง ไม่ต้องรู้จัก)

## 3. Product entities

| Entity | ความหมาย | ขอบเขต |
|---|---|---|
| Installation | Weft ที่ติดตั้งหนึ่งชุด | Config, Admin และหลาย Workspace |
| Workspace | ขอบเขตข้อมูลและสมาชิก | Status definitions, Attribute schemas และ Task numbering |
| Project | เป้าหมายและขอบเขตส่งมอบ | Owner, Access, Tasks และ Milestones |
| Task | หน่วยงานหลัก | Description, Status, Assignee, Attributes และ Discussion |
| Subtask | Task ที่มี Parent | ความสามารถเหมือน Task ปกติ |
| Checklist | ขั้นตอนเล็กภายใน Task | ไม่มี Workflow หรือ Assignee แยก |
| List | กลุ่ม Task ที่เลือกด้วยมือ | อ้าง Task แบบ many-to-many |
| Smart List | Query ที่บันทึกไว้ | ผลลัพธ์ตามสิทธิ์ของผู้เปิด |
| View | รูปแบบแสดง Task | Table, Kanban, Calendar หรือ Timeline |
| Milestone | จุดส่งมอบ | อยู่ใน Project และมีวันเป้าหมาย |
| Comment | บทสนทนา | Markdown, Mentions, References, Files และ Reactions |
| Activity | ประวัติที่แสดงผู้ใช้ | Projection ของผลการเปลี่ยนแปลงที่ยังมีผล |
| Operation | การเปลี่ยนข้อมูลภายใน | Before/after, Actor, Version และ Undo relationships |
| Task reference | การอ้างถึงงาน | เชื่อม Source และ Target โดย Stable IDs |
| AI connection | บัญชี/Runtime แบบ Global, Workspace หรือ Personal | Provider, Auth mode, Allowed users, Capabilities และสถานะพร้อมใช้ |
| AI run | การทำงาน AI หนึ่งรอบ | Initiator, Context scope, Events, Usage และ Result |
| AI proposal | แผนเปลี่ยนข้อมูล | Items ทุกชนิด (Task, Link, Note edit, File, Skill, Schema), Reasons, Sources และ Approval state |
| Agent runner | Process bridge ของผู้ใช้ | เรียก Official CLI/app-server และส่งผลกลับ Weft |
| Team | กลุ่มผู้ใช้ใน Workspace ไม่มี role | Members; รับสิทธิ์บน Project/Vault, ถูก @mention และเป็น Assignee ได้ |
| Vault | ชุดโน้ต Knowledge ใน git repo ภายในหนึ่งอัน | Members (ผู้ใช้/Team/Project), Visibility, Role Viewer/Contributor/Manager |
| Note | ไฟล์ Markdown/HTML/ไฟล์แนบใน Vault | Path, git history, links, tags; เปลี่ยนผ่าน Proposal เท่านั้น |
| Skill | คำแนะนำที่สอน AI เรื่องระบบและวิธีทำงาน | Name, description, body, enabled; scope Workspace |

### ความสัมพันธ์

- Task อยู่ Project หลักได้ไม่เกินหนึ่ง Project แต่เข้าได้หลาย List
- Task ที่ไม่มี Project เป็น Workspace-visible; Personal private tasks อยู่นอก MVP
- Subtask ต้องอยู่ Project เดียวกับ Parent; ป้องกัน Cycle และจำกัด UI เริ่มต้นที่ 5 ชั้น
- Task ผูก Milestone ได้ไม่เกินหนึ่งแห่ง และต้องเป็น Project เดียวกัน
- Dependency (`blocks`/`blocked_by`) แยกจาก Parent และแยกจาก Reference
- การพิมพ์ `#123` ไม่สร้าง Dependency หรือให้สิทธิ์เพิ่มโดยอัตโนมัติ
- List/View ไม่ให้สิทธิ์อ่าน Task; การแชร์ List ไม่ทำให้ Restricted Task หลุดสิทธิ์
- การย้าย Project ต้อง Preview ผลต่อสิทธิ์, Subtasks, Milestone และ Dependencies ก่อนยืนยัน
- Task มี Assignee เป็นชุด แต่ละรายการเป็นผู้ใช้หรือ Team; Team ไม่ใช่ role และไม่ให้สิทธิ์เข้าถึงงานโดยตัวมันเอง
- Vault ไม่ใช่ส่วนของ Project; Project เป็นสมาชิกของ Vault ได้ (ให้สิทธิ์แก่สมาชิก Project ทางเดียว สมาชิก Vault ไม่ได้สิทธิ์เห็น Project)
- Task/Comment อ้างโน้ตได้ทางเดียว; โน้ตไม่รู้จัก Task (`#123` ในโน้ตเป็นข้อความธรรมดา)

## 4. Functional requirements

MUST เป็นข้อบังคับภายใน Phase ของฟีเจอร์นั้น ส่วน SHOULD เป็นสิ่งที่เลื่อนได้เมื่อบันทึกเหตุผล

### F01 — Identity and access

- MUST มี Email/password, Sessions, Logout/revoke และ Admin reset ผ่าน CLI
- Public registration ปิดโดย Default; Bootstrap admin ผ่านคำสั่งที่ไม่เปิดช่องสร้าง Admin ซ้ำ
- มี Workspace roles: Owner, Admin, Member และ Viewer; ห้ามลบ Owner คนสุดท้าย
- Invite links ใช้ครั้งเดียว มีวันหมดอายุและเพิกถอนได้; ไม่ต้องใช้ SMTP
- Optional SMTP และ User self-service reset เพิ่มใน Collaboration phase
- Project visibility: Workspace-visible หรือ Restricted พร้อม Project membership
- Viewer อ่านอย่างเดียว; Contributor แก้ Task/Comment ได้; Manager จัด Project/Membership ได้
- Workspace Viewer เป็นเพดานอ่านอย่างเดียว แม้ตั้ง Project role ผิดเป็น Contributor
- Team รับสิทธิ์บน Project และ Vault ได้ (ดู F13); สิทธิ์จริงของผู้ใช้ = ยูเนียนของสิทธิ์ที่ให้ตรงกับสิทธิ์ผ่าน Team และผ่าน Project ทุกทางที่ผู้ใช้อยู่ แล้วจำกัดด้วยเพดาน Workspace role; ไม่มี deny; การถอนมีผลทันที รวมถึง AI run ที่กำลังทำงานต้องหยุดอ่านและ Apply
- Vault มี role Viewer / Contributor / Manager เหมือน Project: Viewer อ่านโน้ต ค้นหา ให้ AI อ่านและโหลด zip; Contributor สั่ง AI เสนอแก้และกด Approve ได้; Manager จัดสมาชิก ตั้งค่า นำเข้า และลบ Vault
- ผู้สร้าง Vault (Workspace Owner/Admin/Member; Viewer สร้างไม่ได้) เป็น Manager คนแรก; Workspace Admin เห็นรายชื่อ Vault และสมาชิกเพื่อดูแลระบบแต่ไม่เห็นเนื้อหา การอ่านต้องเพิ่มตนเองเป็นสมาชิกและมี Security audit
- Vault Visibility: Restricted (ค่าเริ่มต้น เฉพาะสมาชิก) หรือ Workspace-visible (สมาชิกทุกคนอ่านได้ ส่วนเขียน/จัดการยังเป็นของสมาชิก)
- Admin ไม่อ่าน Restricted content โดยอัตโนมัติ; การเพิ่มตนเองเข้าต้องชัดเจนและมี Security audit
- ไม่อ้างว่า ACL ป้องกันเจ้าของเครื่องหรือ Database administrator ได้

### F02 — Tasks and discussion

- MUST มี Title, Markdown description, Status, Priority, Assignees (ชุดของผู้ใช้หรือ Team; ใครก็ได้ในชุดปิดงานได้), Dates, Watchers และ Attributes
- MUST มี Subtasks, Checklist, Duplicate, Archive/Restore และ Bulk edits
- MUST เปิด Task แบบ Side panel และ Full page ด้วย Stable URL
- MUST มี Comments, @user mentions, Quote/reply, Reactions และ File attachments
- MUST สร้าง Task จากข้อความ พร้อมลิงก์กลับ Source
- MUST มีปุ่ม รับงาน ที่เพิ่มตัวผู้กดเป็น Assignee และถอน Team Assignee ที่ผู้กดสังกัดอยู่ใน Operation เดียว (Undo ได้และลง History) ใช้ Team เป็นที่พักงานใหม่ที่ยังไม่มีคนทำ
- Comments แก้ไขได้พร้อม Edited marker; การลบแสดงตามสิทธิ์และไม่เปิดเผยเนื้อหาเดิมแก่ผู้ไม่มีสิทธิ์
- Discussion และ System activity อยู่ Timeline เดียวกัน แต่มี Filter: All / Discussion / Changes
- Phase แรกไม่ต้องมี General chat หรือ Project/List chat

### F03 — Custom statuses

- MUST เพิ่ม เปลี่ยนชื่อ เปลี่ยนสี เรียง และ Archive Status ได้ผ่าน UI และ Keyboard
- Status definitions เป็น Workspace-wide ในรุ่นแรก เพื่อให้งานข้าม List มีความหมายเดียวกัน
- Categories ภายใน: `backlog`, `not_started`, `active`, `completed`, `canceled`
- ชื่อแสดงผลตั้งเองได้ เช่น Ready for QA, Waiting for customer หรือ In review
- Kanban ใช้ Status ที่ตั้งเองเป็น Column ได้ทันที
- การ Rename ต้องไม่ทำให้ Task references หรือ Saved filters พัง เพราะอ้าง Status ID
- การลบ/Archive Status ที่มีงานอยู่ต้องเลือก Replacement และ Preview จำนวนงาน
- การเข้าสู่ Completed บันทึก completed_at; Reopen เอาค่าออกพร้อมเก็บ Operation สำหรับย้อนกลับ
- ทีมมี Workflow ต่างกันเต็มรูปแบบเป็นงานอนาคต ไม่บังคับใน v1.0

### F04 — Custom attributes

- MUST มีตั้งแต่ Core alpha ไม่เลื่อนไปหลัง Planning
- ชนิดเริ่มต้น: Text, Number, Date, Single select, Multi select และ User
- สร้าง Schema ระดับ Workspace และเลือกใช้ใน Project; Attributes ที่ใช้ร่วมกันอ้าง ID เดียว
- MUST แก้จาก Task panel และ Table cell ได้โดย Keyboard
- MUST ใช้ใน Filter, Sort, Group และ Columns ตามชนิดที่เหมาะสม
- Bulk set/clear, Undo/Redo และ History ต้องรองรับ Custom attributes เช่นเดียวกับ Built-in fields
- Number ไม่บังคับ Integer; กำหนด Validation ได้ตาม Schema
- Select options เปลี่ยนชื่อ/เรียง/Archive ได้โดยไม่ทำให้ค่าที่มีอยู่หาย
- Schema Archive ต้องแจ้งผลต่อ View และห้าม Hard delete ข้อมูลเงียบ ๆ
- Type conversion ต้องมี Preview/Validation; ยังไม่รองรับ Formula หรือ Arbitrary scripts

### F05 — Lists, Smart Lists and views

- Manual List เก็บ References ของ Task; งานเดียวอยู่หลาย List โดยไม่ Duplicate
- Smart List เก็บ Query เช่น Assignee=me AND Status!=completed
- Saved view เก็บ Filter, Sort, Group, Visible columns และ Manual ordering เมื่อใช้ได้
- รองรับ AND/OR, Custom attributes และ Relative date filters ตาม Phase
- Query ผลลัพธ์ต้องใช้สิทธิ์ผู้เปิด ไม่ใช่สิทธิ์เจ้าของ List
- `Assignee=me` นับเฉพาะการ assign ตรงถึงผู้ใช้ และมีตัวเลือก รวมผ่าน Team เพิ่มได้; Team มีมุมมอง Team queue ของงานที่ assign ให้ Team
- สร้าง Task ใน Smart List ให้ Default เฉพาะค่าที่ไม่กำกวม; ไม่เดาค่าใน OR conditions
- Table: Inline edit, Range selection, Copy/paste, Bulk action และ Subtask indentation
- Kanban: Group ตาม Status เริ่มต้น; ย้าย Column ด้วย Keyboard ได้เช่นเดียวกับ Drag
- Calendar/Timeline เพิ่มใน Planning phase โดยใช้ Task ชุดเดิม

### F06 — Task references แบบ GitHub

- `#123` หมายถึง Task number 123 ภายใน Workspace ปัจจุบัน; เลข Task Unique ทั้ง Workspace ไม่ใช่เลขแยก Project
- Workspace prefix เช่น WFT-123 เป็น Display key ทางเลือก; ไม่เปลี่ยน Internal identity
- Stable URL ตัวอย่าง `/w/acme/tasks/123` และ URL เดิมยัง Resolve ได้หลัง Rename task
- พิมพ์ `#` เปิด Autocomplete ค้นด้วย Number หรือ Title และเลือกด้วย Arrow/Enter
- รองรับใน Description และ Comments; โน้ตใน Vault เป็น Knowledge ไม่ใช่ Document entity ของ Task (การอ้างโน้ตดูด้านล่าง)
- ข้อความที่ Commit แล้ว Render เป็นลิงก์/Chip พร้อม Title, Status และ Hover/Focus preview ตามสิทธิ์
- Markdown code blocks, Inline code, Escaped `\#123`, URL fragments และ Headings ต้องไม่ถูกแปลงผิดเป็น Reference
- Parser ต้องแยกจาก @user mention; เก็บ Target UUID หลัง Resolve ไม่พึ่งการ Parse plain text ซ้ำทุกครั้ง
- Number ที่หาไม่พบยังเป็นข้อความธรรมดา และไม่เผยว่ามี Task ที่ผู้ใช้ไม่มีสิทธิ์หรือไม่
- MVP อ้างข้าม Project ใน Workspace เดียวได้; Cross-workspace shorthand ไม่อยู่ในขอบเขต
- ลิงก์ Task URL ภายใน Workspace เดียวกันควร Normalize เป็น Reference ได้
- Task/Comment อ้างโน้ตได้ทางเดียว: พิมพ์ `[[` แล้วเลือกจาก Autocomplete (ค้นเฉพาะโน้ตที่ผู้พิมพ์อ่านได้) หรือวาง URL ของโน้ต ระบบแปลงเป็น Reference เก็บเป็น Vault + path
- เมื่อ Apply ที่ Weft ตรวจพบการเปลี่ยนชื่อ/ย้ายไฟล์ (git rename detection) ให้ปรับ Reference ใน Transaction เดียวกัน; โน้ตที่ถูกลบแสดง โน้ตนี้ถูกลบแล้ว
- แสดงเป็น Chip ชื่อโน้ต + ชื่อ Vault กดเปิดได้; ผู้ดูที่ไม่มีสิทธิ์อ่าน Vault เห็นข้อความกลาง ๆ ไม่เปิดเผยชื่อ; การอ้างโน้ตไม่ให้สิทธิ์เพิ่ม ไม่ Subscribe และไม่แจ้งใคร

### F07 — Backlinks and relationships

- Task ที่ถูกอ้างมีส่วน “Referenced from” พร้อม Source task/comment และตำแหน่งข้อความ
- สร้าง/แก้/ลบ Comment หรือ Undo Description ต้องปรับ Reference index และ Backlinks ให้ตรงผลปัจจุบัน
- Reference ซ้ำในข้อความเดียวไม่สร้าง Backlink ซ้ำ; References คนละ Source แยกได้
- กรองสิทธิ์ทั้ง Source และ Target ทุกครั้งก่อนแสดงชื่อ Snippet Count และ Preview
- การอ้าง Restricted task ใน Publicer source ไม่ให้ผู้อ่าน Source เห็นชื่อ Target ที่อ่านไม่ได้
- การอ้างถึงงานไม่ Subscribe ผู้ใช้หรือส่ง Notification ไปทุก Watcher โดย Default
- Explicit relations แยกเป็น Related, Duplicate และ Blocks; ใส่ # อย่างเดียวเป็นเพียง Reference
- Keywords เช่น `fixes #123` ไม่ปิดงานอัตโนมัติ และไม่เชื่อม PR ใน Roadmap นี้
- โน้ตไม่มี Backlink จาก Task และ `#123` ในโน้ตเป็นข้อความธรรมดา (Backlinks ระหว่างโน้ตด้วยกันอยู่ใน F12)

### F08 — Inbox and My work

- My work: Assigned to me แบ่ง Overdue, Today, Upcoming และ No due date
- My work แสดงงานที่ assign ผ่าน Team ในส่วน ผ่าน Team แยกจาก assign ตรง
- การ assign ให้ผู้ใช้แจ้ง Inbox ผู้นั้น; การ assign ให้ Team ไม่แจ้งสมาชิกทุกคน (เห็นใน Team queue และส่วน ผ่าน Team)
- `@team` ใน Comment/Description แจ้งสมาชิก ณ ตอนที่พิมพ์ (คนที่เข้าทีมทีหลังไม่ถูกแจ้งย้อนหลัง) เฉพาะผู้ที่อ่าน Task นั้นได้ และไม่ให้สิทธิ์เข้าถึง
- Inbox: Assignment, @mention, Reply และเหตุการณ์ที่เลือกจาก Watchers
- Read/unread แยกจาก Dismiss; มี Mute และ Deduplication
- Notifications ต้องอ้าง Operation group เพื่อถอนรายการที่ยังไม่อ่านเมื่อ Undo ได้
- History ที่ยุบอาจถอน Unread in-app notification; สิ่งที่คนอ่านไปแล้วหรือ Email ที่ส่งแล้วเรียกคืนไม่ได้
- จึงควร Debounce อีเมลแจ้ง Attribute changes และไม่ส่งทุก Keystroke
- ตรวจสิทธิ์ก่อนคืน Preview และก่อนส่ง Event; Mention ไม่สร้างสิทธิ์เข้าถึง

### F09 — Search and command palette

- ค้น Task number, Title, Description, Comments และ Custom attributes ตามชนิด
- โน้ตค้นแยกในแท็บ Knowledge (ชื่อเรื่อง ข้อความ properties tags ชื่อไฟล์) ผลลัพธ์ จำนวน และ Snippet กรองตามสมาชิก Vault; Command palette ค้น Task/Comment และพิมพ์ชื่อโน้ตเพื่อ ไปที่โน้ต ได้
- โน้ตใช้ Postgres full-text (`simple`) + `pg_trgm` สำหรับค้นบางส่วนของคำ ไม่มี vector DB; ไม่อ้างว่ามีการตัดคำไทย ต้องทดสอบพฤติกรรมไทยจริง; ไฟล์ Binary/LFS ไม่ index เนื้อหา (ค้นได้เฉพาะชื่อไฟล์)
- เริ่มจาก PostgreSQL; ภาษาไทยต้องทดสอบ Exact/Substring behavior ไม่อ้างว่ามี Thai full-text segmentation โดยยังไม่วัด
- Command palette เรียกได้ทุกหน้าที่ไม่ถูก Native dialog บัง และใช้เปิดหน้า/สร้างงาน/เปลี่ยนฟิลด์/เปิด Settings ได้
- Search results, Counts, Snippets และ Autocomplete ต้องกรอง ACL
- จำกัด Query complexity, Page size และมี Pagination

### F10 — Projects, Milestones and dependencies

- Project มี Name, Key, Description, Owner, State, Target dates และ Access settings
- Milestone มี Name, Target date, Description และ State: Planned/Active/Completed/Canceled
- Dependencies ห้าม Self-reference/Cycle รวม Concurrent requests
- Progress เริ่มจาก Completed leaf tasks / Eligible leaf tasks ไม่นับ Parent ซ้ำกับ Subtasks และไม่นับ Archived/Canceled
- ไม่มีงานให้แสดง “ยังไม่มีงาน” ไม่แสดง 100%
- Milestone ไม่ Complete เองเพียงเพราะ Task ครบ; เสนอให้ผู้ดูแลตรวจส่งมอบ
- เปลี่ยนวันไม่เลื่อนงานทั้งหมดอัตโนมัติในรุ่นแรก
- Calendar และ Timeline ต้องมี Keyboard equivalent สำหรับเลือกวัน/เปลี่ยนช่วงเวลา/จัด Dependencies

### F11 — Export and recovery

- MUST มี Workspace JSON export แบบ Versioned schema พร้อม Attachments; Admin เป็นผู้เริ่ม
- Backup Installation ต้องเก็บ Database, Attachments, Vault repos (รวม `.git/lfs`) และ Keys/config ที่จำเป็นตั้งแต่ Private alpha
- JSON Import เพิ่มก่อน Beta พร้อม Dry run และ Reference validation
- CSV export สำหรับใช้งานข้อมูลเพิ่มใน Planning phase; CSV ไม่ใช่ Backup
- Archive/Restore เป็นการจัดการงานหลัก; Hard delete/purge เพิ่ม Flow ชัดเจนใน Release-hardening phase
- Export และ Restore ต้องรักษาสถานะ Reverted/Suppressed ของ History และไม่คืน Log ที่ Undo แล้วขึ้นมาใหม่

### F12 — Knowledge (Vault และโน้ต)

- Workspace มีได้หลาย Vault; หนึ่ง Vault คือ git repo ภายใน (worktree) หนึ่งอัน ตรงกับ vault ของ Obsidian หนึ่งอัน
- git เป็นที่เก็บเวอร์ชันภายในเท่านั้น: เฉพาะ Weft commit ผ่าน `git` CLI + `git-lfs`; ไม่มี endpoint git, token หรือ push สำหรับผู้ใช้; ผู้ใช้อ่านผ่านเว็บ และโหลด zip snapshot ของ `main` ตามสิทธิ์อ่าน (รวมไฟล์ Binary จริง) เพื่อเปิดใน Obsidian
- Manager นำเข้า vault เดิมได้ (`git clone --mirror` จาก URL หรืออัปโหลด) โดยไม่เขียนประวัติใหม่; โฟลเดอร์ `.obsidian/` ที่ติดมาไม่แสดงบนเว็บ AI ไม่อ่าน และ Weft ไม่รันปลั๊กอินในนั้น
- ผู้ใช้ไม่แก้โน้ตตรง ๆ ไม่มี Markdown editor บนเว็บหรือมือถือ; หน้าโน้ตมีปุ่ม ขอให้ AI แก้ ที่เปิดแชต AI ผูกกับโน้ตนั้นและได้ Proposal ที่มี diff เล็ก ๆ ให้ Approve
- เพิ่มไฟล์ (รูป/PDF) โดยแนบในแชต AI แล้ว AI เสนอ เพิ่มไฟล์ + ใส่ลิงก์ในโน้ต เป็นรายการใน Proposal พร้อมตัวอย่าง ไม่มีอัปโหลดตรงเข้า Vault
- ไฟล์ข้อความ (นามสกุล md, txt, csv, json, html ฯลฯ และไม่มีไบต์ NUL) เก็บใน git ปกติ; ไฟล์อื่นทั้งหมดเก็บเป็น Git LFS (pointer ใน git, ตัวไฟล์ใน `.git/lfs`) โดย `.gitattributes` ที่ seed ไว้ระบุนามสกุล Binary ที่พบบ่อยให้ตรงกัน; เพดานไฟล์เริ่มต้น 50 MB (ต้องวัด); นำเข้าไม่เขียนประวัติใหม่ ไฟล์ Binary เก่าอยู่ใน git ตามเดิม
- ประวัติของโน้ตคือ `git log` เท่านั้น ไม่มี History compaction หรือ suppression; Undo คือ revert commit ใหม่ (ไม่เขียนประวัติทับ) ใช้กับ Proposal ที่ Apply แล้ว และ Conflict ทั้งกลุ่มถ้าไฟล์ถูกแก้ต่อ
- แสดงผล: wikilinks, aliases, heading/block links, embeds, frontmatter/properties, tags, callouts และ Backlinks ระหว่างโน้ต; ไม่รองรับ Canvas, Dataview และปลั๊กอิน (ไฟล์ยังอยู่ใน git เว็บแสดงเป็นไฟล์ดิบหรือข้าม)
- กฎ resolve ลิงก์ `[[...]]` ภายใน Vault เดียว (Obsidian ไม่กำหนดเอง): (1) path เต็มตรงก่อน (2) ไม่งั้นจับชื่อไฟล์ไม่รวมนามสกุลแบบไม่สนตัวพิมพ์ และ frontmatter `aliases` (3) หลายไฟล์ให้เลือกที่ใกล้โฟลเดอร์ของโน้ตต้นทางที่สุด (โฟลเดอร์เดียวกัน แล้วขึ้นไปหาบรรพบุรุษ) เสมอกันเลือก path ตามลำดับตัวอักษรและติดป้าย กำกวม (4) ไม่พบ = ลิงก์ที่ยัง resolve ไม่ได้ ไม่สร้างไฟล์ให้; เก็บ `#หัวข้อ` และ `^บล็อก`; ไม่ resolve ข้าม Vault (ข้าม Vault ใช้ URL ของโน้ต)
- การเปลี่ยนชื่อไฟล์ที่ AI เสนอต้องมีรายการแก้ลิงก์ที่ชี้มาใน Proposal เดียวกัน
- Index (ชื่อเรื่อง ข้อความ properties tags ลิงก์ออก) คำนวณใน Preflight จาก merge commit ที่เตรียมไว้และเขียนใน Postgres Transaction เดียวกับการ Apply จึงไม่เก่ากว่า `main`; Import หรือเปลี่ยนเวอร์ชัน parser รัน Reindex ทั้ง Vault เบื้องหลัง (ระหว่างนั้นเนื้อหาที่ยังไม่ index ค้นไม่ได้และหน้าเว็บบอกสถานะ)
- ใช้ parser เดียวฝั่ง server (เสนอ comrak) สร้างทั้งข้อมูล index และ HTML ที่ sanitize สำหรับเว็บ ฝั่ง client ไม่ parse Markdown; เก็บเวอร์ชัน parser กับ index; ต้องทดสอบทิศของ `[[target|alias]]` ก่อนใช้
- HTML: แทรกในโน้ต Markdown ได้ตาม allowlist (ไม่มี script); ไฟล์ `.html` ทั้งหน้าแสดงในกรอบกัก (รายละเอียดใน §10); ไฟล์ `.html` เป็นข้อความ index เฉพาะข้อความที่มองเห็นและ `<title>`
- ในช่วงที่ยังไม่รองรับหน้า `.html` แบบมีสคริปต์ (ดู §12) ไฟล์ `.html` แสดงเป็นซอร์สดิบ

### F13 — Teams

- Workspace Owner/Admin สร้าง เปลี่ยนชื่อ ลบ Team และจัดสมาชิก; Team ไม่มี role และไม่ซ้อนกัน; ผู้ใช้อยู่ได้หลาย Team; Team ไม่ใช่ role ของ Workspace
- Team ได้รับสิทธิ์บน Project และ Vault ตาม F01; เป็น Assignee ได้; รับ `@team`
- ชื่อ Team คำอธิบายสั้น และรายชื่อสมาชิกเห็นได้โดยสมาชิกทุกคนของ Workspace (ไม่มี Team ส่วนตัวใน v0.4)
- AI tool `list_teams` คืนชื่อ คำอธิบายสั้น และสมาชิกเท่านั้น ไม่คืนสิทธิ์/grants ของ Project หรือ Vault ที่ผู้เรียกมองไม่เห็น
- แนวทางทำงานของทีมที่ยาว ให้เขียนเป็น Skill ไม่ใส่ในคำอธิบาย Team
- บริษัทหนึ่ง = Workspace หนึ่ง; แยกโครงการด้วย Project; ปิดโครงการด้วย Restricted + Team grant; แยกเอกสารลับด้วย Vault; ต้องการแยกขาดจริง ๆ ใช้คนละ Workspace (ยอมรับว่า Status/Attribute ใช้ร่วมกันทั้ง Workspace ใน v0.4)

### F14 — Skills

- Skill มี `name` (ไม่ซ้ำใน Workspace), `description` สั้น (~300 ตัวอักษร บอก AI ว่าควรเปิดเมื่อไร), `body` เป็น Markdown และ `enabled`; เพดานขนาด body เริ่มต้น ~16,000 ตัวอักษรและจำนวน Skill ที่ enabled พร้อมกัน (วัดทีหลัง)
- Scope Workspace เท่านั้นในรุ่นแรก; Team/ส่วนตัวเลื่อนไปอนาคต
- เฉพาะ Workspace Owner/Admin สร้าง แก้ ปิด Archive ผ่านเว็บ มี History/Undo ผ่าน Operation ledger; AI เสนอแก้ผ่าน Proposal ได้เมื่อผู้สั่งมีสิทธิ์นั้น
- Skill ที่ enabled อ่านได้โดยสมาชิกทุกคน (รวม Viewer) และเนื้อหาถูกส่งให้ผู้ให้บริการ AI เมื่อใช้ หน้าแก้ต้องเตือนว่า ห้ามใส่ความลับ
- ส่งถึง AI ผ่าน `list_skills` (ชื่อ + คำอธิบาย) และ `get_skill` (เนื้อหา) เท่านั้น ไม่ยัดทั้งหมดเข้า prompt; ไม่ซิงก์กับ skills ของ Claude Code/Codex
- body ใช้ `#123` และ `@team` เป็นลิงก์ได้ แต่ไม่ขยายเนื้อหาปลายทางเข้า context อัตโนมัติ; ไม่ลิงก์โน้ต
- Skill ไม่ให้สิทธิ์ใด ๆ; ข้อความที่อ้างว่า X เป็นแอดมิน ไม่ทำให้ X ได้สิทธิ์
- Workspace ใหม่ถูก seed Skill เดียวชื่อ How this Workspace works (ภาษาอังกฤษ แก้ได้) อธิบาย Task/Assignee/Team/Proposal และบอก AI ให้ใช้ `list_teams`, `list_attributes`; ไม่ถูกเขียนทับเมื่ออัปเกรด เวอร์ชันใหม่เสนอผ่าน Proposal diff

### F15 — Mobile-first PWA

- ออกแบบหน้าจอเล็กก่อน แล้วขยายเป็น Desktop; ติดตั้งเป็น PWA ได้; แคชเพื่ออ่านได้ ไม่เขียนแบบ Offline
- โครง: แท็บล่าง (Inbox, My work, Proposal/Review, Knowledge, More); Command palette เป็นไอคอน ⌘ มุมขวาบนที่เปิดเป็น Bottom sheet; Undo เป็น Toast หลัง Apply และเป็นคำสั่งในพาเล็ตต์
- หน้า Proposal: เช็กลิสต์เดียวจัดกลุ่มตามชนิด (Tasks, Links, Knowledge, Skills, Schema) แสดง kept/total ต่อกลุ่ม แตะแถวเพื่อดู diff/รายละเอียด; Subtask ย่อหน้าใต้ Parent; แถบ Approve ติดล่างแสดงสรุปจำนวนและปุ่ม Approve ปุ่มเดียว ไม่มีหน้ายืนยันเพิ่ม
- ติ๊กรายการออกแล้วรายการที่พึ่งมัน (เช่น Link, Subtask) หลุดตามพร้อมข้อความแจ้ง เพื่อไม่มี Dangling edges; ติ๊กรายการที่พึ่งกลับเข้ามาจะเพิ่มรายการที่ต้องใช้กลับด้วย
- รายการ Stale ทำให้ปุ่ม Approve ใช้ไม่ได้จนกว่าจะ Refresh diff หรือเอาออก
- ขณะ Apply แสดงว่า Vault ถูกล็อกสั้น ๆ และไม่ต้องทำอะไร
- Full shortcuts ใช้บน Desktop; บนมือถือทุกปุ่มและแถวต้อง focus ได้และทำงานกับคีย์บอร์ดบลูทูธ (Tab, Space ติ๊ก, Enter ขยาย) ไม่มี shortcut เฉพาะมือถือใน v0.4
- ไม่มี Markdown editor; หน้าโน้ตมีปุ่ม ขอให้ AI แก้

## 5. History, Undo/Redo และการแก้กลับค่าเดิม

ส่วนนี้เป็น **Core feature** ต้องออกแบบตั้งแต่ต้น ไม่เพิ่มทีหลังเป็นเพียง Toast

### 5.1 แยกข้อมูลสามประเภท

| ชั้น | หน้าที่ | พฤติกรรมเมื่อ Undo |
|---|---|---|
| Visible task activity | Timeline ที่ผู้ใช้เห็น | รายการของการแก้ที่ถูกย้อนหายไปหรือยุบตามผลสุทธิ |
| Internal operations | ใช้ Undo/Redo, Versioning และ Realtime | เก็บ Before/after และ Mark reverted; ไม่ลบทิ้งเพื่อให้ดูเหมือนยังไม่เคยแก้ใน Database |
| Security audit | Membership, Session, Export และ Admin actions | ไม่ซ่อนหรือลบจาก Task undo |

การที่ “Log หาย” หมายถึงหายจาก Visible task timeline รวม API ที่ใช้แสดง Timeline ไม่ใช่แค่ซ่อนด้วย CSS ข้อมูล Internal operations ไม่ถูกเปิดให้ผู้ใช้ทั่วไปค้นประวัติที่ซ่อนไปแล้ว

### 5.2 กติกาบันทึกประวัติ

- การเปลี่ยน Title, Description, Status, Assignee, Priority, Dates, List membership, Parent, Milestone และ Custom attributes ต้องบันทึก Operation
- เก็บ Actor, Server timestamp, Before/after, Task version, Command ID และ Operation group ID
- ทุก Saved mutation บันทึกทันทีแบบ Transaction; Timeline อาจแสดงผลแบบ Compacted projection
- Value เดิมและใหม่ต้อง Normalize ก่อนเปรียบเทียบ เช่น null/empty ตามชนิด และ Set equality สำหรับ Multi select
- No-op ไม่สร้าง Activity, Notification หรือ Task version ใหม่จาก Content change
- ห้ามใช้ Auto trim ที่ทำลายความหมาย Description/Markdown; นิยาม Equality ต้องชัดต่อชนิด
- Field changes แบบคนละคนไม่รวมเป็นก้อนเดียว; ข้อความ Comment ไม่ถูกยุบหายเพราะชื่อตรงกับ Task

### 5.3 Editing session และ net-change compaction

- ใน Editor ที่ยังไม่ Save: Typing หลายครั้งเป็น Draft เดียว; ย้อนกลับค่าเดิมก่อน Save จะไม่มี Server operation
- เมื่อ Save หลายครั้ง: ยุบการแก้ต่อเนื่องของ Actor เดียวบน Field เดียวของ Task เดียวเป็น Effective change จากค่าเริ่มต้นถึงค่าล่าสุด
- การยุบต้องมี Causal chain ต่อเนื่อง ไม่มี Actor อื่นแก้ Field นั้นคั่น ไม่มี Non-compensable side effect และไม่ข้าม Checkpoint ที่ทำให้ย้อนอย่างปลอดภัยไม่ได้
- ไม่ใช้เงื่อนไข “ภายในไม่กี่วินาทีเท่านั้น” เป็นตัวตัดสินว่ากลับค่าเดิมหรือไม่; เวลาใช้ช่วย Group UX แต่ไม่แทน Equality/Causality
- ถ้าผลสุทธิกลับค่าเริ่มต้น ให้ Mark กลุ่มเป็น Suppressed และ Timeline ไม่แสดงรายการนั้น
- ถ้าคนอื่นแก้ Field นั้นคั่น ต้องคง History ที่มีความหมายของแต่ละคน ไม่ยุบข้ามจนลบร่องรอยคนอื่น
- การแก้ Field อื่นหรือเพิ่ม Comment ไม่จำเป็นต้องกีดกันการยุบของ Field เดิม แต่ Comment และ Reference ที่ยังมีผลต้องยังอยู่
- ใช้ Operation IDs เดิมและสถานะ Projection สำหรับ UI reconciliation ไม่สร้าง Timeline entry ใหม่ไม่รู้จบ

### 5.4 ตัวอย่างผลที่ต้องได้

| การกระทำ | ผลข้อมูล | Timeline |
|---|---|---|
| Status Todo → Doing | Doing | แสดง Todo → Doing |
| กด Undo ทันที | Todo | รายการ Todo → Doing หาย |
| กด Redo | Doing | รายการเดิมกลับมาอย่างมีความหมาย |
| Title A → B แล้วคนเดิมแก้ B → A โดยไม่มีคนอื่นแก้ Title คั่น | A | รายการเปลี่ยน Title ใน Chain นั้นหาย |
| Title A → B → C | C | แสดงผลสุทธิ A → C แทนรายการย่อยรก |
| Custom select X → Y → X | X | ยุบเหมือน Built-in field |
| คน ก แก้ A → B; คน ข แก้ B → C; คน ก แก้ C → A | A | ไม่ยุบข้ามคน ข; ยังคงเหตุการณ์ที่มีความหมาย |
| Undo Description ที่เคยเพิ่ม #123 | Description เดิม | Activity ของการแก้หาย และ Backlink จากการแก้นั้นถูกนำออก |
| Save ค่าเดิมโดยไม่เปลี่ยน | ค่าเดิม | ไม่มี Activity ใหม่ |

### 5.5 Undo/Redo command semantics

- `Mod+Z` ย้อน Operation group ล่าสุดของผู้ใช้ภายใน Active workspace และ UI session ปัจจุบัน ไม่ใช่ Undo เหตุการณ์ล่าสุดของทุกคน
- `Mod+Shift+Z` ทำ Redo; รองรับ `Ctrl+Y` เป็น Alias ที่ไม่ชน Editor ตาม Platform
- เมื่ออยู่ใน Text editor ให้ Native/editor undo จัดการ Draft ก่อน; Task-level Undo เรียกผ่าน Command palette/Action menu ได้เสมอ
- History actions บน Timeline ให้ย้อนการแก้ของตนเองที่ยัง Eligible ได้; ผู้ใช้ทั่วไปไม่ย้อน Operation ของคนอื่น
- ก่อน Undo/Redo Server ตรวจสิทธิ์ปัจจุบันและค่าปัจจุบันของทุก Field ที่ได้รับผล
- ถ้าค่าหรือความสัมพันธ์ถูกคนอื่นเปลี่ยนจนไม่ตรง Expected state ให้ Conflict ไม่ทับข้อมูลคนอื่น
- คนอื่นแก้คนละ Field ให้ Undo ของเราทำได้เมื่อ Preconditions ของ Field ที่เกี่ยวข้องยังตรง
- Task version เพิ่มเมื่อ Apply Undo/Redo จริง แม้ Visible activity หาย; Client ต้องไม่ถือ Version ลดลง
- Bulk edit คือ User operation group เดียว; Undo ทั้งกลุ่ม Atomic เมื่อ Preconditions ของทุกงานผ่าน มิฉะนั้นไม่แก้บางส่วนเงียบ ๆ และแจ้งงานที่ Conflict
- Fresh action หลัง Undo ตัด Redo branch ใน Session นั้น; Refresh/Re-login ไม่รับประกัน Keyboard undo stack เดิม
- Internal operations เก็บอย่างน้อยจนถึง Explicit retention checkpoint; History UI ปิด Undo ของกลุ่มที่ Undo data ถูก Purge แล้ว พร้อมเหตุผล
- Redo action ที่ถูก Compaction ต้องคำนวณ Projection ใหม่ ไม่ทำให้รายการที่ยังเป็น No-op กลับมารก

### 5.6 ขอบเขต Undo รุ่นแรก

- รองรับ Field edits, Custom attribute edits, List membership, Reordering, Parent changes, Milestone assignment และ Archive/Restore
- Task creation Undo ทำเป็น Archive เพื่อลดความเสี่ยงงานที่มีคนอ้างแล้ว ไม่ Hard delete ID
- Schema changes เช่น ลบ Status/Attribute ไม่อยู่ใน Keyboard undo รุ่นแรก; ใช้ Archive/Restore/Replacement ที่ชัดเจน
- การส่ง Comment ใช้ Edit/Delete ของข้อความ ไม่รวม Task mutation undo stack ในรุ่นแรก
- การส่งอีเมล การ Download/Export และการเปลี่ยนสิทธิ์ไม่ถูกย้อนจาก Task-level Undo
- มีคำอธิบายและ Disabled state สำหรับ Undo ที่ทำไม่ได้ ไม่ปล่อยให้ผู้ใช้กดแล้วเงียบ

### 5.7 Knowledge กับ History

- ประวัติของโน้ตคือ `git log` ของ Vault เท่านั้น ไม่มี Compaction/Suppression เพราะ commit ที่ถูกอ่านไปแล้วลบไม่ได้; ทุกการ Apply เป็น commit จริงใน `main`
- Operation ledger เก็บเพียงตัวชี้ (`vault`, `from_sha`, `to_sha`, Proposal id) เพื่อให้ Proposal หนึ่งเป็น Undo group เดียวข้าม Postgres และ git
- Undo ฝั่ง Knowledge = สร้าง revert commit ใหม่ ไม่เขียนประวัติทับ; ตรวจเงื่อนไขทั้งกลุ่มก่อน (ไฟล์ที่ Proposal แตะต้องยังเหมือนที่ `to_sha`) ไม่ตรงข้อใดให้ Conflict ทั้งกลุ่มและไม่ทำเลย; Redo คือ revert ของ revert ภายใต้เงื่อนไขเดียวกัน
- ไม่มี Undo ของ การ save โน้ตโดยผู้ใช้ เพราะผู้ใช้ไม่แก้โน้ตตรง ๆ

## 6. Full keyboard specification

### 6.1 Required coverage

ผู้ใช้ต้องทำ Journey ต่อไปนี้ได้โดยไม่ใช้ Mouse: Login → เลือก Workspace → สร้าง List/Project → สร้าง Task/Subtask → ตั้งทุกฟิลด์ → สนทนา/อ้าง Task → เปลี่ยน View → Bulk edit → Undo/Redo → ค้นหา → จัด Status/Attributes → เปิด Settings → Logout

Keyboard support รวม Popovers, Date pickers, Modals, Menus, Comboboxes, File picker และ Error recovery ไม่ใช่เพียง Shortcut สร้าง Task

### 6.2 Default mappings ที่เสนอ

`Mod` คือ Cmd บน macOS และ Ctrl บน Windows/Linux; Shortcuts ไม่ Override Browser/OS ที่จำเป็น และปรับได้เมื่อมี Conflict

| การทำงาน | Keyboard behavior |
|---|---|
| Command palette | Mod+K |
| Shortcut help | ? เมื่อไม่ได้พิมพ์ใน Editor |
| Global task search | / เมื่อไม่ได้พิมพ์ใน Editor |
| Create task | C เมื่อไม่ได้พิมพ์ใน Editor |
| Navigate table | Arrow keys; Tab/Shift+Tab ย้าย Cell หรือ Control ตาม Mode |
| Edit selected cell | Enter หรือ F2; Enter Commit และ Esc Cancel |
| Open task | Mod+Enter; มี Command ที่ค้นได้สำหรับ Side panel/Full page |
| Multi-select | Shift+Arrow หรือ Shift+Space ตาม Selection mode |
| Bulk actions | เปิด Action menu ของ Selection จาก Keyboard |
| Indent/outdent | Tab/Shift+Tab ใน Task-title outline mode เท่านั้น; Cell/form mode ไม่ดัก Tab |
| Move task / reorder | Action menu หรือ Command; ไม่บังคับ Drag-and-drop |
| Kanban navigation | Arrow keys ย้าย Card/Column; Command เลือกสถานะปลายทาง |
| User mention | @ ตามด้วย Search, Arrow และ Enter |
| Task reference | # ตามด้วย Search, Arrow และ Enter |
| Send comment | Mod+Enter; Enter เป็น Newline |
| Undo task action | Mod+Z นอก Text-edit context |
| Redo | Mod+Shift+Z และ Platform alias ที่เหมาะสม |
| Close overlay | Esc; คืน Focus จุดเดิม |

Bindings เป็นข้อเสนอ ไม่อ้างว่าเหมือน Height ทุกปุ่ม แต่ต้องครอบคลุมการทำงานเทียบเท่าและแสดงใน Help/Command palette

### 6.3 Focus and accessibility rules

- มี Focus indicator, Logical tab order, Skip links และ Accessible names
- Modal Trap focus อย่างเหมาะสมและคืน Focus เมื่อปิด; Nested popover ปิดเฉพาะชั้นบนก่อน
- Single-letter shortcuts ไม่ทำงานใน Input, Contenteditable หรือระหว่าง IME composition ภาษาไทย
- Virtualized Table ต้องรักษา Focus/Selection เมื่อ Scroll หรือ Realtime refresh
- มี Browse/Edit/Outline modes ชัดเจน พร้อมคำแนะนำเพื่อไม่ให้ Tab สร้าง Subtask โดยไม่ตั้งใจ
- เมื่อแถวถูก Archive/Filter ออก ให้ย้าย Focus ไปแถวใกล้เคียงอย่างคาดเดาได้
- Date picker พิมพ์วันที่ได้โดยตรง ไม่บังคับใช้ Calendar mouse
- Color/status ไม่อาศัยสีอย่างเดียว; Screen reader อ่านสถานะและ Undo result ได้
- File upload เรียก Native picker ผ่าน Keyboard ได้ และไม่บังคับ Paste/Drag
- Shortcuts ไม่ต้องใช้ทุกปุ่มเป็นทางลัดโดยตรง แต่ทุก Action ต้องเข้าถึงด้วย Focus navigation หรือ Command palette

### 6.4 มือถือ

- Single-letter shortcuts และชุดคีย์ลัดเต็มใช้บน Desktop เท่านั้น
- บนมือถือทุก control และแถวต้อง focus ได้และทำงานกับคีย์บอร์ดบลูทูธ (Tab/Shift+Tab, Space ติ๊ก, Enter ขยาย diff, Esc ปิด sheet) ไม่ต้องมี shortcut เฉพาะมือถือ
- Touch target ต้องกดด้วยนิ้วได้สบาย และ Bottom sheet/Drawer ต้องคืน Focus เมื่อปิด

## 7. Domain เดียวและ Docker deployment

### 7.1 Public routing contract

สมมติ Public base URL เป็น `https://weft.example.com` ทุกสิ่งที่ Browser ใช้ต้องอยู่ Origin นี้

| Path | หน้าที่ |
|---|---|
| / | Web app และ Client routes |
| /assets/* | Frontend assets |
| /api/v1/* | API และ Auth endpoints |
| /ws | WebSocket endpoint |
| /files/* | Authenticated attachments และ Downloads |
| /vault-pages/* | หน้า HTML ของ Vault ในกรอบกัก (header sandbox/CSP ตรวจสมาชิก Vault ทุกครั้ง) |
| /vault-files/* | ไฟล์ใน Vault (รูป, ไฟล์ LFS) ที่ตรวจสมาชิก Vault ทุกครั้ง |
| /health/live | Liveness |
| /health/ready | Readiness |

- ไม่มี `api.example.com`, `files.example.com` หรือ Auth domain เพิ่มเป็น Requirement
- ไม่มี endpoint `/git` หรือ git over HTTP: git ของ Vault เป็นที่เก็บภายใน ไม่มีใคร clone/push จากภายนอก
- Production frontend ใช้ Relative URLs; WebSocket derive scheme เป็น wss จาก Public HTTPS URL
- Auth cookie เป็น Host-only ตามความเหมาะสม ไม่ต้องตั้ง Wildcard cookie domain
- CORS ไม่ใช่ส่วนหนึ่งของการสื่อสารปกติระหว่าง UI กับ API เพราะ Same-origin
- Database และ Storage อยู่ Internal network ไม่เปิด Public port โดย Default
- ถ้าเพิ่ม S3 ภายหลังให้ Browser ยังเรียก /files ผ่าน App proxy; Presigned URL ไป Storage origin อื่นไม่ตรง Contract นี้
- TLS จัดการโดย Reverse proxy ของผู้ติดตั้ง หรือ Proxy ตัวอย่างใน Compose; ไม่บังคับ SaaS tunnel
- API/Files/WS ต้องผ่าน Proxy routes ถูกต้อง รวม WebSocket upgrade และ Body-size limit
- Core runtime ไม่พึ่ง CDN assets/Fonts ภายนอกเพื่อให้ติดตั้งแบบเครือข่ายปิดได้หลังได้ Image แล้ว; AI แบบ Cloud subscription ต้องเชื่อมต่อ Provider ภายนอก
- Domain เดียวหมายถึง First-party Weft UI/API/WS/Files/MCP/Runner endpoints; การ Login ที่ Provider และ Inference outbound เป็นข้อยกเว้นที่จำเป็น ไม่ทำ Proxy ปลอมหน้า Login ของ Provider

### 7.2 Required repository layout

```text
weft/
  crates/
    weft-core/         # Domain, ACL, history and undo policies
    weft-db/           # PostgreSQL queries and migrations
    weft-server/       # API, websocket, auth and static assets
    weft-jobs/         # Outbox, notifications and maintenance jobs
    weft-ai/           # Proposals, context policies and provider adapters
    weft-agent/        # Personal or centrally managed isolated runner bridge
    weft-knowledge/    # Vault git layer (git CLI/git-lfs), Markdown parser and note index
    weft-cli/          # Serve, worker, migrate and admin commands
  apps/
    web/               # React + TypeScript
  docker/
    Dockerfile         # Multi-stage Rust + frontend production build
    compose.yml        # App + PostgreSQL, single-replica supported baseline
    compose.dev.yml    # Optional development setup
    compose.agent.yml  # Optional personal/global isolated runner profiles
    .env.example       # Non-secret sample configuration
    README.md          # Install, backup, upgrade and proxy examples
    proxy/             # Optional same-domain proxy config
  docs/                # Developer/operator documentation; not product Documents
  tests/
  .dockerignore
```

ไฟล์ใน docs/ เป็นเอกสารของ Repository ไม่ใช่ฟีเจอร์ Documents/Wiki ในผลิตภัณฑ์

### 7.3 Docker requirements

- Build context เป็น Repo root และ Dockerfile อยู่ `docker/Dockerfile`
- ตัวอย่างเริ่มต้น: `docker compose --env-file docker/.env -f docker/compose.yml up -d`
- ผู้ใช้ Copy docker/.env.example เป็น docker/.env ก่อนใช้; ไม่ Commit Secrets จริง
- Production image รวม Frontend assets และ Rust executable; ไม่ต้องรัน Node/Vite dev server ใน Production
- Production image มี `git` และ `git-lfs` ที่ใช้โดย `weft-knowledge` (ตรวจเวอร์ชันที่ทดสอบ เช่น git 2.39.5 บน Debian bookworm)
- Runtime ใช้ Non-root user พร้อมสิทธิ์ Volume ที่ระบุชัด
- Named volumes สำหรับ PostgreSQL, Attachments และ Vault repos (รวม `.git/lfs`); Config/Keys ต้อง Backup ด้วย
- มี Migration one-shot พร้อม Lock ก่อน App ready และ Health checks
- App เผย HTTP port เดียว; Optional proxy เผย 80/443 บน Public domain เดียวกัน
- รองรับ Graceful shutdown และกู้ Jobs ที่ค้างได้
- Pin release tags; ไม่มี Default password และไม่ต้องติดต่อ License server
- Development setup ใช้ Same-origin proxy เพื่อให้ Relative API paths และ WS ใกล้ Production
- Optional agent profile ไม่ฝัง Provider credentials ใน Image และไม่ Mount Docker socket หรือ Host home ทั้งหมด
- Core image ไม่บังคับติดตั้ง Provider binaries; Official CLI ติดตั้งบนเครื่องผู้ใช้หรือ Isolated runner ตามคู่มือและเงื่อนไขการแจกจ่ายของ Provider
- Multi-replica, HA และ Zero-downtime schema migration อยู่นอกการรับรอง v1.0 รุ่นแรก

## 8. Architecture and persistence

### 8.1 Stack proposal

| ส่วน | ข้อเสนอ |
|---|---|
| API/runtime | Rust, Axum, Tokio |
| Database | PostgreSQL + SQLx |
| Frontend | React + TypeScript + Vite |
| API contract | REST JSON ภายใต้ /api/v1 และ OpenAPI |
| Realtime | WebSocket + Authorized HTTP snapshot/catch-up |
| Jobs | PostgreSQL queue + Transactional outbox |
| Files | Local volume ผ่าน App authorization |
| Packaging | OCI image + Docker Compose ใน docker/ |
| Knowledge | `git` CLI + `git-lfs` (worktree ต่อ Vault), comrak (Markdown), Postgres full-text + `pg_trgm` |

เลือก Dependency stable versions และตรวจ License/Security ใน Phase 0; เอกสารนี้ไม่ระบุเวอร์ชันล่าสุดของ Libraries

### 8.2 Shared application commands

UI, API และ Worker ต้องใช้ Domain validation/ACL ชุดเดียว State, Internal operation, Activity projection, References และ Outbox ต้อง Commit อย่างสอดคล้องกัน

ไม่จำเป็นต้องทำ Event-sourcing ทั้งระบบ ใช้ Current-state tables + Operation ledger + Derived activity/reference projections ได้

### 8.3 Tables ขั้นต้น

| กลุ่ม | ตัวอย่าง |
|---|---|
| Identity | users, sessions, invitations |
| Access | workspaces, workspace_memberships, project_memberships |
| Work | projects, tasks, checklist_items, milestones, task_dependencies |
| Organization | lists, list_memberships, task_list_memberships, saved_views |
| Customization | status_definitions, attribute_definitions, attribute_options, attribute_values |
| Discussion | comments, reactions, task_watchers, attachments |
| References | task_references (source kind/id, target task id) |
| History | operations, operation_groups, activity_projection, undo_links |
| Delivery | notifications, notification_preferences, outbox_events, jobs |
| Security | security_audit_events |
| Teams | teams, team_memberships |
| Knowledge | vaults, vault_memberships (principal: user/team/project), note_index, note_links, task_note_references, vault_apply_locks |
| Skills | skills |
| AI | ai_connections, ai_connection_grants, ai_default_policies, agent_runners, ai_runs, ai_run_events, ai_proposals, ai_proposal_items, ai_approvals, ai_tool_grants |

- Internal UUIDs; Task number monotonically allocated และ Unique ใน Workspace; ไม่ใช้เลขเดิมซ้ำหลัง Archive/Purge
- Operation ledger เก็บตัวชี้ commit ของ Vault (`vault`, `from_sha`, `to_sha`, Proposal id) ไม่เก็บเนื้อหาโน้ตซ้ำ
- Timestamp ใช้ UTC; Due date/Milestone date ใช้ Date-only ไม่แปลงเลื่อนวัน
- Mutable entities มี Version; IDs ที่ส่งจาก Client ต้องตรวจ Workspace/Project consistency
- Parent, Milestone และ Membership มี Constraints และ Transaction boundaries ชัดเจน
- Dependency cycle validation ต้อง serialize Graph mutations ที่จำเป็นเพื่อกัน Race
- Reference index และ Timeline projection ต้อง Rebuild จากข้อมูลภายในที่มีสิทธิ์/Retention เพียงพอได้
- Index ตาม Workspace, Project, Assignee, Status, Due date, Task number และ Reference target

## 9. Concurrency, realtime and API

### 9.1 Concurrent editing

- Regular edits ส่ง Expected version; Stale writes ตอบ 409 พร้อม Current state/version ให้ Resolve
- ห้าม Silent last-write-wins สำหรับ Title/Description
- Undo ใช้ Field/relationship preconditions ตาม Section 5 ไม่ Reject เพียงเพราะ Field อื่นเปลี่ยน
- ไม่มี Character-level concurrent description merge ใน v1.0; Conflict UI ต้องรักษา Draft ของผู้ใช้
- Comments ใช้ Request ID เพื่อไม่ให้ Retry สร้างข้อความซ้ำ
- Bulk edits คืน Per-item results; Bulk undo ตรวจทั้ง Group แบบ Atomic ตามกติกา

### 9.2 Realtime

- State, Operations และ Outbox Commit พร้อมกันก่อนส่ง Event
- Events ตัวอย่าง: task.changed, activity.revised, comment.created, reference.changed, access.revoked
- Event ส่ง Entity/Operation IDs และ Version ที่จำเป็น; Client ต้องรับการ Update/Remove Activity เดิมได้ ไม่ Append อย่างเดียว
- Undo หรือ Compaction ส่ง Activity removal/revision ไปทุก Client ที่มีสิทธิ์
- Event delivery เป็น at-least-once; Client Deduplicate และ Reconcile state
- หลัง Reconnect ต้องจัดการ Deleted/Archived tasks และ Revoked access ด้วย Snapshot/tombstones ไม่ดึงแค่ Rows ที่ Updated
- การถอนสิทธิ์หยุด Subscription และล้าง Scope cache; Attachment/Preview API ต้องตรวจสิทธิ์ซ้ำ
- Presence/Typing ไม่เป็น Release blocker; ไม่ใช้ Presence แทน Read receipt

### 9.3 API outline

| Method | Path | หน้าที่ |
|---|---|---|
| GET/POST | /api/v1/workspaces/{id}/tasks | ค้นหาและสร้างงาน |
| GET/PATCH | /api/v1/tasks/{id} | อ่าน/แก้พร้อม Version |
| GET | /api/v1/tasks/{id}/activity | Visible compacted timeline |
| POST | /api/v1/operation-groups/{id}/undo | Undo หลังตรวจสิทธิ์/Preconditions |
| POST | /api/v1/operation-groups/{id}/redo | Redo ที่ยัง Eligible |
| GET | /api/v1/tasks/{id}/references | Backlinks ที่กรอง ACL |
| POST | /api/v1/tasks/{id}/comments | สนทนาและบันทึก References |
| GET/POST | /api/v1/workspaces/{id}/statuses | อ่าน/สร้าง Custom status |
| GET/POST | /api/v1/workspaces/{id}/attributes | อ่าน/สร้าง Attribute schema |
| GET/POST | /api/v1/workspaces/{id}/teams | อ่าน/สร้าง Team และสมาชิก |
| GET/POST | /api/v1/workspaces/{id}/vaults | อ่าน/สร้าง Vault และสมาชิก |
| GET | /api/v1/vaults/{id}/notes/{path} | อ่านโน้ตที่ render แล้ว (ตามสิทธิ์) |
| GET/POST | /api/v1/workspaces/{id}/skills | อ่าน/จัดการ Skill |
| POST | /api/v1/proposals/{id}/approve | Approve (เฉพาะ session ผู้ใช้ ไม่เรียกผ่าน token หรือ MCP) |

นี่เป็น Contract outline ไม่ใช่ Endpoints ที่ Implement แล้ว มี Cursor pagination, Page limit และ Structured validation errors ทุก Collection/API ที่เกี่ยวข้อง

Internal operation ledger ไม่เปิดเป็น Public Task history endpoint; Security audit มี Access policy แยก

## 10. Security, portability and quality

- Password hash ใช้ Argon2id พร้อม Parameters ที่วัดกับเครื่องเป้าหมาย
- Host-only HttpOnly cookie, Secure บน HTTPS, SameSite และ CSRF protection สำหรับ Cookie-authenticated writes
- ตรวจ WebSocket Origin/Session และไม่เชื่อ Reverse proxy headers จากทุก Source
- Login rate limits, Session expiration/revoke และ Secret redaction ใน Logs
- Sanitize Markdown, Safe link rendering และ CSP
- Attachment keys ไม่ใช้ชื่อไฟล์เป็น Path; Download ผ่าน ACL; ไม่ Serve HTML/SVG upload เป็น Trusted app document
- ป้องกัน Cross-workspace references, Search snippets/counts, Backlinks และ Notification leaks
- การแก้ Status/Attribute, History compaction และ Undo ต้องไม่เปิดเผยค่าเก่าจาก Project ที่ผู้ใช้ถูกถอนสิทธิ์แล้ว
- Telemetry ปิด Default; Core ไม่บังคับ Internet runtime หรือบริการภายนอก ส่วน Cloud AI ต้องมี Provider connection
- Backup ใช้ Maintenance mode หยุด Writes เพื่อให้ Database กับ Local attachments สอดคล้อง
- Restore drill ตรวจ Task counts, Permissions, Operations, Suppressed activity, References, Attachment checksums, ความสอดคล้องของ Vault repos กับ Postgres และ LFS objects ที่ประวัติ git ชี้ถึง
- Upgrade มี Pinned image version, Migration lock, Backup instructions และ Breaking-change notes
- JSON export ไม่เท่ากับ Full installation backup; Rollback schema ใช้ Restore จนมีการทดสอบย้อน Migration จริง
- Repository มี README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT และ License ที่ยืนยันแล้วก่อน Public release
- เนื้อหา HTML ใน Vault ถือเป็นข้อมูลไม่น่าเชื่อถือ (เขียนโดย AI จากข้อมูลที่อาจถูก prompt injection): HTML ที่แทรกในโน้ต Markdown ผ่าน allowlist ที่ parser ตัวเดียวฝั่ง server (อนุญาต `details`, `summary`, `table` และส่วนย่อย, `div`/`span` ที่มีแค่ `class`, `br`, `hr`, `kbd`, `sub`, `sup`, `figure`, `figcaption`, `img` ที่ `src` เป็นไฟล์ใน Vault, `a` ที่ `href` เป็น http/https/mailto หรือ path ในแอป; ไม่อนุญาต `script`, `style` ทั้งแท็กและ attribute, `iframe`, `object`, `embed`, `form`, `input`, `svg` inline, `on*` และ `javascript:`)
- ไฟล์ `.html` ทั้งหน้าเสิร์ฟจาก `/vault-pages/*` เท่านั้น ด้วย `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'`, `X-Content-Type-Options: nosniff` และตรวจสมาชิก Vault ทุกครั้ง; ฝังในหน้าโน้ตด้วย `<iframe sandbox="allow-scripts">` เท่านั้น (ไม่มี `allow-same-origin`, `allow-popups`, `allow-top-navigation`, `allow-forms`) เพื่อให้ยังอยู่ origin เดียวแต่ไม่เข้าถึง cookie/API ของแอป; SVG แสดงผ่าน `<img>` เท่านั้น
- หน้า `.html` รัน JavaScript แบบ inline ได้ ห้ามโหลดหรือส่งข้อมูลออกภายนอก ไฟล์แยกใช้ได้เฉพาะจาก Vault เดียวกัน; นี่เป็นการลดความเสี่ยง ไม่ใช่การรับประกัน (CSP ไม่ครอบคลุมทุกช่อง เช่น WebRTC, DNS prefetch, ลิงก์ที่ผู้ใช้กดเอง) และต้องทดสอบกับเบราว์เซอร์จริงก่อนปล่อย
- Proposal ที่มีหน้าแบบมีสคริปต์ติดป้าย มีสคริปต์ และแสดงตัวอย่างที่ render ในกรอบกักก่อน Approve

## 11. AI transformation specification

### 11.1 เป้าหมายและวงจรการทำงาน

Weft ต้องรองรับวงจร Goal → Clarify → Plan → Create/link tasks → Refine → Track → Review โดยไม่บังคับให้ผู้ใช้จัดข้อมูลทุกช่องด้วยมือ AI มีทั้ง Global assistant, Project assistant และ Task-level actions

ตัวอย่างคำสั่ง:

> ช่วยเปิดงานทำระบบ Subscription แบ่งเป็น API, Web และ QA มี Milestone UAT พร้อมบอกว่างานไหนรอกัน

AI ต้องเสนอ Tasks พร้อมขอบเขต Acceptance criteria, Subtasks, Typed links และ Assumptions จากนั้นผู้ใช้เลือกสร้างทั้งแผนหรือเฉพาะบางงานได้ คำว่า “เปิดงาน” รองรับทั้งสร้างงานใหม่และค้นหาเปิดงานที่มีอยู่ โดยแสดงเจตนาให้ชัดก่อนเปลี่ยนข้อมูล

AI transformation ไม่ได้หมายถึงให้ AI เขียนข้อมูลเอง AI ไม่มีสิทธิ์เขียนหรือ Apply: ทุกการเปลี่ยนแปลงถูกเตรียมครบเป็น Proposal เดียวแล้วคนกด Approve ครั้งเดียว ข้อมูลและคำสั่งหลักถูกออกแบบให้ AI อ่านและเสนอได้ครบ ภายใต้สิทธิ์ของผู้สั่ง

### 11.2 AI capability coverage

| Capability | พฤติกรรมที่ต้องรองรับ |
|---|---|
| Goal → tasks | สร้าง Task/Project draft จากเป้าหมายหรือข้อความที่ผู้ใช้ให้ |
| Generate task | ชื่อ รายละเอียด Acceptance criteria และฟิลด์ที่เหมาะสม |
| Split task | เสนอ Parent/Subtasks หรือ Peer tasks พร้อมเหตุผลและรายการส่วนที่ยังคงอยู่ในงานเดิม |
| Link tasks | เสนอ Related, Duplicate, Blocks และ Parent/subtask แบบแยกชนิด |
| Find/open | ค้นหาและเปิด Task ที่มีอยู่ด้วยภาษาธรรมชาติ |
| Improve task | ชี้ Requirement ที่ขาด คำถามที่ต้องตอบ และความกำกวม |
| Triage | แนะนำ Status, Priority, Attributes และ Assignee ตามข้อมูลที่ผู้ใช้มีสิทธิ์ |
| Plan milestone | เสนอ Milestones, Sequencing และงานที่เสี่ยงส่งไม่ทัน |
| Summarize | สรุป Task chat, ความคืบหน้าและ Blockers พร้อม Source links |
| Bulk operations | เสนอแก้หลายงานพร้อม Preview และ Operation group |
| Customization | เสนอ Status/Attribute schema; การ Apply ต้องใช้สิทธิ์จัด Schema |
| Knowledge | ค้นและอ่านโน้ต (ตามสิทธิ์ผู้สั่ง) และเสนอแก้โน้ต/เพิ่มไฟล์เป็นรายการใน Proposal |
| Skills | อ่าน Skill ที่ enabled; เสนอสร้าง/แก้ Skill เมื่อผู้สั่งมีสิทธิ์ |
| Ongoing review | ผู้ใช้เรียก Review backlog หรือ Run ตาม Schedule ที่อนุญาตเฉพาะได้ |

AI ใช้ Tasks, Comments, Attributes, Milestones, โน้ตใน Vault (ตามสิทธิ์ผู้สั่ง), Skills และไฟล์ที่เลือกเป็นแหล่งข้อมูล ไม่สร้าง Requirement repository ใหม่โดยปริยาย

### 11.3 Generate/split/link UX

- มี “Generate with AI” ใน Create task, “Suggest split” และ “Suggest links” ใน Task panel และ Command palette
- ผู้ใช้ใช้ Global/Workspace default ได้ทันทีโดยไม่ต้อง Login AI ส่วนตัวเมื่อ Mode นั้นรองรับ หรือเลือก Personal connection/Provider/Context scope เองตาม Policy
- ถ้าข้อมูลไม่พอให้แสดง Assumptions/Questions ไม่แต่ง Requirement เป็นข้อเท็จจริง
- ตรวจงานที่คล้ายกันก่อนเสนอสร้างใหม่; ใช้เฉพาะ Candidate tasks ที่ผู้ใช้มีสิทธิ์
- แสดง Proposal แบบ Editable rows/Tree พร้อม Title, Description, Acceptance criteria, Status/Attributes, Parent และ Link types
- แต่ละรายการมีเหตุผลและ Source references เมื่อมี; ไม่แสดง Confidence เป็นค่าความน่าจะเป็นที่อ้างว่าแม่นยำโดยยังไม่ได้วัด
- ผู้ใช้ Rename, Merge drafts, Reject, Regenerate หรือ Select subset ได้โดย Keyboard ทั้งหมด
- Regenerate เฉพาะรายการได้และต้องเก็บ Manual edits เว้นแต่ผู้ใช้เลือกแทนที่
- ก่อน Apply แสดง Create/update/link counts, Access scope และ Assignee/date ที่ AI เดาไว้
- การ Split ไม่ Archive/Complete งานต้นทางเงียบ ๆ; Default เก็บงานเดิมเป็น Parent พร้อมลูก หรือเสนอ Peer tasks ให้ผู้ใช้เลือก
- ไม่มีการโอน Comment/Attachment เดิมไปลูกอัตโนมัติ; Link กลับ Source เพื่อไม่ทำลายบริบท
- ถ้าเลือกบางรายการแล้วขาด Parent/Dependency ให้แจ้งแก้แผน ไม่สร้าง Dangling edges
- หน้าตรวจ Proposal ตามหลัก F15: เช็กลิสต์จัดกลุ่มตามชนิด, Subtask ย่อหน้าใต้ Parent, แถบ Approve ติดล่างปุ่มเดียว, รายการที่พึ่งกันถูกตัดออกพร้อมกัน, รายการ Stale ต้อง Refresh หรือเอาออกก่อน, ป้าย มีสคริปต์ พร้อมตัวอย่างในกรอบกัก
- โน้ตเป็นรายการใน Proposal แสดง diff ของข้อความ และตัวอย่างที่ render สำหรับไฟล์ `.html`; ไฟล์แนบแสดงตัวอย่างก่อน Approve

### 11.4 Typed task graph

| Link | ความหมาย | Validation |
|---|---|---|
| parent_of / subtask_of | แตกขอบเขตงาน | Parent เดียวต่อ Task, Project เดียวกัน และไม่มี Cycle |
| blocks / blocked_by | งานต้องรอกัน | ไม่มี Cycle และไม่บังคับ Parent เดียวกัน |
| related_to | เกี่ยวข้องแต่ไม่บังคับลำดับ | Symmetric และไม่ซ้ำ/ไม่อ้างตัวเอง |
| duplicate_of | งานซ้ำกับงานหลัก | Directed, ไม่ทำ Duplicate cycle และไม่ปิดงานเอง |
| reference | กล่าวถึงในเนื้อหา | สร้างจากข้อความและใช้ Backlinks เดิม |

- AI เสนอ Typed edges ได้ทั้งระหว่าง Draft tasks และกับ Existing tasks
- Proposal ใช้ Temporary IDs ก่อน Commit และ Server map เป็น UUID/Task numbers ใน Transaction
- Relation storage และ Validation อยู่ Server ไม่พึ่ง Model output ว่าปลอดภัยแล้ว
- ต้องเห็น Graph/List ของความสัมพันธ์และเปิดแต่ละ Task ได้; Graph visualization ไม่บล็อกการใช้ Links ในระยะแรก
- Dependency จะไม่เปลี่ยน State งานเป็น Waiting โดยอัตโนมัติจนมี Rule ที่ผู้ใช้เปิดอย่างชัดเจน

### 11.5 Provider and subscription architecture

**ข้อเท็จจริงจากเอกสารทางการที่ตรวจ 29 October 2026:** Codex มี ChatGPT sign-in สำหรับ Subscription และ API-key mode แยกกัน; รองรับ app-server สำหรับ Embedded agent UX และ exec สำหรับ Structured jobs ส่วน Claude Code มี Programmatic CLI และข้อกำหนดการรันในผลิตภัณฑ์ที่ให้ผู้ใช้แต่ละคนยืนยันตัวตนด้วยบัญชี/Key ของตนเอง ดู Sources ท้ายหัวข้อนี้

Weft ใช้ Provider adapters ไม่ Reverse-engineer Consumer chat endpoints และไม่ดึง Browser cookies มาเรียกแทน API

| Mode | แนวทางที่เสนอ | Billing/identity |
|---|---|---|
| Codex subscription | Official Codex process/app-server บน Runner ส่วนตัวที่ผู้ใช้ Login | ใช้สิทธิ์ของบัญชีที่เลือก ตาม Limits/Policies จริง |
| Claude subscription | Official Claude Code บน Runner ส่วนตัว โดยใช้ Auth flow ที่รองรับ | บัญชี Claude ของผู้ใช้เอง ไม่มี Shared pool |
| API key | Adapter แยกสำหรับผู้ที่เลือกเอง | Usage-based; UI ระบุชัดว่าเป็น API billing |
| Direct provider OAuth | เพิ่มได้เมื่อ Integration ได้รับสิทธิ์และทดสอบจริง | ไม่ถือว่า Login สำเร็จแล้วใช้ Plan inference ได้ทุกกรณี |

- Subscription support เป็น Product requirement แต่ต้องผ่าน Per-provider capability/auth smoke test ก่อนประกาศรองรับ CLI version หรือ Plan ใด
- ห้ามอ้างว่า Subscription เท่ากับ API credits ทั่วไปหรือ Unlimited usage
- ไม่สลับจาก Subscription ไป API แบบเสียเงินเงียบ ๆ และไม่สลับบัญชีผู้ใช้เพื่อหลบ Limit
- Browser Login เป็น Provider-hosted flow; Weft ไม่เก็บ Password ผู้ให้บริการ
- Personal mode ใช้บัญชีของ User คนนั้นเท่านั้น; Global mode ใช้ Central connection ที่ตั้งใจให้ใช้งานร่วมกันและมีสิทธิ์จาก Provider รองรับ ไม่แปลง Personal credential เป็น Shared pool โดยอัตโนมัติ
- Official provider credentials อยู่ใน OS credential store/Private runner volume แยกต่อผู้ใช้ ไม่ลง Task DB, Logs, Prompt หรือ Export
- API secrets ถ้าเก็บฝั่ง Server ต้อง Encrypt ด้วย Key ที่เก็บแยกและมี Rotation/Revoke
- Quota/Model availability แสดงตามข้อมูลที่ Provider คืน; หากอ่าน Remaining usage ไม่ได้ให้แสดง Unknown ไม่สร้างตัวเลขเอง
- Rate limit → Paused พร้อมเหตุผล/Retry ที่มีขอบเขต; Auth expired → Needs login; ไม่วน Login/Retry ไม่สิ้นสุด
- Claude CLI mode สำหรับ Subscription ต้องไม่ใช้ Mode ที่เอกสารระบุว่าปิด Subscription auth; ตรวจ Flags กับรุ่นที่รองรับจริง
- General-purpose unattended jobs ใช้เฉพาะ Auth mode และการให้สิทธิ์ที่ Provider รองรับ; ไม่อ้างว่า Personal subscription ใช้เป็น Shared server API ได้

### 11.5A Global AI — ตั้งครั้งเดียวให้ทีมใช้ร่วมกัน

**Global AI เป็น Required feature ของ AI alpha** ผู้ดูแลตั้ง Provider/Model/Connection/Runner ครั้งเดียว แล้วสมาชิกที่ได้รับอนุญาตกด Generate, Split, Link และ Review ได้โดยไม่ต้องตั้ง AI ส่วนตัวทุกคน

| Scope | ผู้ตั้งค่า | ผู้ใช้งาน |
|---|---|---|
| Installation global | Installation admin | Workspaces/users/groups ที่ Connection grant อนุญาต |
| Workspace default | Workspace admin | สมาชิก Workspace ที่ได้รับ Grant |
| Personal | เจ้าของ User | เจ้าของเท่านั้น |

- Connection เก็บ Scope, Provider, Auth/Billing mode, Credential reference, Runner, Model defaults, Allowed users/workspaces, Capabilities และ Limits
- Default resolution: Explicit allowed selection → Workspace default → Installation default; Personal connection ใช้เมื่อผู้ใช้เลือก/ตั้งเป็นค่าตนเองและ Policy อนุญาต
- Global ready connection ต้องใช้งานจากสมาชิกได้โดยไม่ขอ Provider sign-in รายคน เว้นแต่ Provider mode นั้นกำหนด Individual auth; กรณีนั้น UI แสดง Needs personal sign-in ชัดเจนและไม่อ้างว่าเป็น Shared ready
- รองรับ Central organizational API/provider credentials สำหรับ Global inference ตามสิทธิ์ของเจ้าของบัญชีและข้อกำหนดของ Provider
- Global Subscription mode เป็น Capability-gated: เปิดเมื่อ Plan/Auth flow/ข้อตกลงรองรับการใช้หลาย End users จริง ไม่ถือว่า CLI login ด้วย Personal Pro/Max/Plus บัญชีเดียวเพียงพอ
- การแจก Weft เป็น Open source ไม่ทำให้มีสิทธิ์แจก Subscription inference ของ Provider ให้คนอื่นโดยอัตโนมัติ; Source availability และ Provider entitlement เป็นคนละเรื่อง
- ถ้า Shared subscription ไม่รองรับ ให้สถานะ Unsupported shared mode/Requires individual auth พร้อมทางเลือก API/organization plan ที่ผู้ดูแลเลือกเอง ไม่สลับ Billing เงียบ ๆ
- Provider และ Model กลางใช้ชุดเดียวกันได้ แต่ Conversation/session/context ต้องแยกตาม User + Workspace + Run; ไม่ Resume session ล่าสุดของคนอื่น
- Skill ระดับ Workspace (F14) ใช้เป็นแนวทางกลางของ AI เช่น รูปแบบ Task/Definition of done; Skill ไม่ให้สิทธิ์เพิ่ม; Skill ส่วนตัว/ระดับ Team เลื่อนไปอนาคต
- Shared memory ถ้าทำ ให้เป็น Explicit ACL-scoped knowledge ที่กำหนดได้ ไม่รวมข้อความ Private ของทุกคนเป็น Memory ก้อนเดียว
- Global AI ไม่ใช่ Global data access: ทุก Search/tool call/Proposal apply ใช้ Initiator ACL ตามปัจจุบัน
- แยก Connection admin (ตั้งค่ารันและค่าใช้จ่าย) จาก Data access (อ่าน Tasks/Prompts); ผู้จัด Connection ไม่ได้อ่าน Prompt history ของทุก User โดยอัตโนมัติ
- Central runner รับ Typed jobs ที่ Server เซ็น/ยืนยัน Owner grants และไม่เปิด Shell/Host filesystem ให้สมาชิกสั่งได้
- Queue มี Global concurrency limit, Per-user concurrency/rate budget, Fair scheduling และ Workspace limits กันผู้ใช้คนเดียวกินคิวทั้งหมด
- Global spend/usage dashboard แสดง Aggregated usage กับ User attribution โดยไม่ต้องเปิดเผย Prompt/Task content; Metadata access ต้องจำกัดด้วย
- Disable/rotate/revoke Global connection หยุดรับงานใหม่และ Cancel/Pause งานค้างตามนโยบาย พร้อมแจ้งผู้ใช้ที่ได้รับผล
- Member ถูกถอน Grant หรือสิทธิ์ Workspace ระหว่างรันต้องหยุดอ่าน/Apply แม้ Global service credential ยังใช้ได้
- Provider fail/Quota limit ร่วมกันให้แจ้งว่ากระทบ Connection กลาง; Fallback ไป Provider/Personal/API อื่นได้เมื่อผู้ใช้/Admin อนุญาตล่วงหน้าชัดเจนเท่านั้น
- Global AI settings, Connection grants และ Switching defaults มี Security audit ที่ Task undo ลบไม่ได้

**Acceptance example:** Admin ตั้ง Global AI ที่ใช้ Central connection mode ที่ได้รับอนุญาต → สมาชิก A และ B เห็นตัวเลือก “Use team AI” และ Generate ได้ทันที → A อ่านได้เฉพาะ Project ของ A, B อ่านได้เฉพาะ Project ของ B → Quota เป็นของ Connection กลาง แต่ Prompts/Sessions/Task permissions ไม่ปนกัน

### 11.6 Local runner and Docker topology

- `weft-agent` เป็น Rust bridge ที่รันบนเครื่องผู้ใช้หรือ Isolated per-user container บน Self-hosted server
- Runner เปิด Outbound authenticated connection ไป Weft domain เดิมที่ `/api/v1/agent/*` และรับ Jobs ที่มี Lease
- ไม่ต้องเปิด Public inbound port บนเครื่องผู้ใช้หรือเพิ่ม Localhost HTTP API ที่หน้าเว็บต้องเรียกข้าม Origin
- Pair ด้วย Single-use code, ระบุ Owner user หรือ Installation/Workspace admin-managed connection, Allowed users/workspaces, Runner identity และ Revoke ได้จาก Settings
- Server ส่งได้เฉพาะ Typed AI jobs ไม่ใช่ Arbitrary shell command strings; Runner Verify owner/scope และแสดงการเชื่อมต่อที่กำลังใช้
- Process invocation ใช้ Argument arrays/stdin ไม่ต่อ Prompt เป็น Shell command
- Run ใน Empty isolated working directory; ไม่โหลด Hooks, Skills, Plugins หรือ MCP จาก Host/project ที่ไม่ได้อนุญาต
- Default planning run ไม่มี Shell/File write tools; Tools ที่เปิดให้เป็น Weft scoped tools เท่านั้น และต้องบังคับด้วย Runtime config/sandbox ไม่ใช่ Prompt อย่างเดียว
- ถ้า Provider ไม่สามารถจำกัดเครื่องมือได้ตาม Contract ให้ปิด Adapter mode นั้นจนแก้ Isolation ได้
- ไม่ Mount Home ทั้งหมด, SSH keys, Production secrets หรือ Docker socket เข้า Runner
- Personal Docker runner แยก Volume/config/credential store ต่อ User; Global runner มี Central service credential store แยกจาก Personal stores และห้าม Mount Auth directory เดียวข้ามโหมด
- Runner offline → Job queued/paused ไม่ล็อกหน้า Task; Personal runner ไม่รับงานคนอื่น ส่วน Global runner รับเฉพาะ Authorized connection jobs และแยก Context/Session ต่อ Initiator
- Credentials ที่ใช้ Run อยู่บนเครื่องใด เครื่องนั้นเป็น Trust boundary; ระบุชัดในคู่มือโดยไม่ส่ง Credentials มารวมที่ Server อัตโนมัติ

### 11.7 Context, ACL and tools

- Context scope เป็น Intersection ของ Initiator permissions, Selected project/tasks และ Connection grants ไม่ว่าใช้ Global หรือ Personal AI; Global connection owner/admin ไม่ใช่ตัวแทนสิทธิ์อ่าน Task ของ Initiator
- Server กรอง Context ก่อนส่ง Provider; ให้ผู้ใช้ Preview รายการ Sources ได้ และแสดงว่า Run ส่งข้อมูลออก Provider ใด
- การค้นหาแบบใช้ Tools เป็นค่าเริ่มต้น ไม่จำเป็นต้องมี Embeddings/Vector DB สำหรับรุ่นแรก
- Attachments ส่งเฉพาะเมื่อผู้ใช้เลือกและ Adapter รองรับชนิดนั้น; ระบุข้อจำกัดขนาด/Parsing
- Token budgets, Context truncation และ Sources ที่ไม่ถูกส่งต้องตรวจสอบได้; ไม่สรุปเหมือนอ่านครบเมื่ออ่านไม่ครบ
- AI มีเฉพาะ Capabilities แบบอ่านและเสนอ: อ่าน `tasks.read`, `notes.read`, `skills.read`, `teams.read`; เสนอ `tasks.propose`, `relations.propose`, `notes.propose`, `skills.propose`, `schema.propose`; ไม่มี Capability เขียนหรือ Apply สำหรับ AI (ไม่มี `tasks.write`, `relations.write` ใน tool ของ AI); Backend ตรวจทุก Tool call
- Tools อ่าน: `search_tasks`, `get_task`, `list_attributes`, `list_teams`, `list_skills`, `get_skill`, `list_vaults`, `search_notes`, `read_note`; Tools เสนอ: `propose_tasks`, `propose_split`, `propose_links`, `propose_note_edit`, `propose_file_add`, `propose_skill_edit`, `propose_schema_change`, `validate_proposal`; การรัน AI หนึ่งรอบสร้าง Proposal ร่างเดียวที่เติมผ่าน `propose_*` และจบที่สถานะ Ready
- External Claude/Codex clients เชื่อมผ่าน `/mcp` บน Domain เดิมด้วย Tool ชุดเดียวกัน; โทเค็น MCP ผูกกับผู้ใช้หนึ่งคน สิทธิ์จริง = สิทธิ์ผู้ใช้ ∩ Capability ที่ให้โทเค็น สร้าง/เพิกถอนใน Settings; การเพิกถอนระหว่างรันหยุด Tool ทันที
- MCP และ AI ไม่เขียน DB หรือ git โดยตรง และ Approve ทำได้เฉพาะคนผ่านเว็บ (session ผู้ใช้) ไม่มี Tool `apply_proposal` สำหรับ AI; Proposal ที่เสนอผ่าน MCP ไปปรากฏบนเว็บเป็น Ready ให้คนมา Approve
- Revocation ระหว่าง Run หยุด Tools และห้าม Apply แม้ตอนสร้าง Proposal เคยมีสิทธิ์
- Task/Comment/Attachment content เป็น Untrusted data ไม่ใช่คำสั่งเพิ่มสิทธิ์; ไม่ให้ Prompt injection เปลี่ยน Owner/Provider/Tool grants
- เนื้อหา Task, Comment, โน้ต และไฟล์แนบส่งให้โมเดลเป็นผลลัพธ์ของ Tool ที่มีป้ายแหล่งที่มา ไม่ใช่คำสั่ง; Skill เป็นแนวทางที่ Admin เขียนแต่ไม่เพิ่มสิทธิ์
- ขอบเขตของรอบ = Project/Vault/Task ที่ผู้ใช้เลือกตอนสั่ง `validate_proposal` ปฏิเสธรายการนอกขอบเขตเว้นแต่ผู้ใช้ขยายเอง; ทุกรายการมีเหตุผลและแหล่งอ้างอิง
- `read_note` ส่งกลับเป็นช่วง (แบ่งตามหัวข้อ มี offset/continuation) และ `search_*` ส่งไม่เกิน 20 รายการพร้อม Snippet; ผลที่ถูกตัดมี `truncated: true` และขนาดรวม; มีเพดานจำนวนครั้งเรียก Tool และตัวอักษรที่อ่านรวมต่อรอบ (เริ่มต้น 40 ครั้ง และ 200,000 ตัวอักษร ต้องวัด); บันทึกแหล่งที่อ่านจริง (โน้ต + commit sha, Task id) แนบ Proposal เป็น Sources
- `propose_note_edit` รับชุดคำสั่งแก้ (แทนที่ช่วงข้อความ, แทรกหลังหัวข้อ, ต่อท้าย) พร้อม `base_sha` ของไฟล์ ให้ server นำไปใช้กับข้อความจริงและสร้าง diff เอง ปฏิเสธถ้าข้อความเป้าหมายหายหรือกำกวม; ไฟล์ใหม่ใช้ข้อความเต็ม; `propose_file_add` ใช้ได้เฉพาะไฟล์ที่ผู้ใช้แนบในรอบนั้น

### 11.8 Proposal lifecycle and commit

State: Draft → Generating → Ready → Approved → Applying → Applied; มี Failed, Canceled, Rejected, Stale และ needs_attention

- Server validate Structured output ตาม Versioned JSON schema และจำกัดจำนวน Items/Edges/ข้อความ
- Proposal หนึ่งก้อนครอบคลุมทุกชนิดการเขียน: Task, Relations, การแก้โน้ต/เพิ่มไฟล์, Skill, Status/Attribute schema; ผู้ใช้ติ๊กเอาบางรายการออกก่อน Approve ได้ แล้ว server ตรวจซ้ำและตัดรายการที่พึ่งกันออกพร้อมกัน
- Proposal เก็บ Initiator, Provider connection, Sources (แหล่งที่อ่านจริง รวม commit sha ของโน้ต), Expected entity versions, Base sha ของไฟล์, Draft IDs, Edges, Assumptions และขอบเขตของรอบ
- ทุกการเขียนโดย AI ต้องมี Human approval ไม่มี Pre-authorized policy และ AI/token/MCP Apply เองไม่ได้; Approve เป็น session ผู้ใช้ผ่านเว็บเท่านั้น; แก้หลัง Approve ต้อง Approve Revision ใหม่ ผูก Approval กับ Content hash และ Base versions
- ไม่มี Batch ซ่อน: Proposal มีเพดานเดียว (จำนวนรายการ, ขนาด diff, จำนวน Vault เริ่มต้นสูงสุด 3) เกินเพดานให้ server ปฏิเสธตั้งแต่ Generate พร้อมเหตุผลและให้ AI ลดขอบเขตหรือผู้ใช้แบ่งคำสั่ง; ตัวเลขจริงวัดใน Phase 0
- ลำดับ Apply แบบเดินหน้าอย่างเดียว (git เป็นขั้นสุดท้าย เพราะย้อนยากกว่า):
  1. Preflight: ตรวจฝั่ง Postgres และสร้าง merge commit ของแต่ละ Vault โดยยังไม่ขยับ `main` (`git merge-tree --write-tree` + `commit-tree`) เก็บ sha ไว้ และคำนวณ index ของโน้ต
  2. ล็อกเขียนสั้น ๆ ต่อ Vault (เรียงตาม Vault id กัน deadlock) ระหว่างล็อก Proposal อื่นบน Vault เดียวกันรอคิว
  3. Postgres Transaction เดียว: เขียนทุกการเปลี่ยนฝั่ง DB รวม index ของโน้ต ตั้ง Proposal เป็น `applying` และเก็บ sha ที่เตรียมไว้
  4. `git update-ref` แบบ compare-and-swap ต่อ Vault จาก sha เดิมไป sha ใหม่ แล้วตั้ง `applied`; ปล่อยล็อกเมื่อครบทุก Vault
  5. Recovery job ทำขั้น 4 ต่อได้ซ้ำ (ถ้า ref อยู่ sha เดิมก็ update ถ้าอยู่ sha ใหม่ก็ตั้ง `applied`); ไม่ Roll back git ไม่ว่ากรณีใด
- Proposal ที่แตะหลาย Vault อนุญาตได้ (สูงสุดตามเพดาน) ระหว่างทางบาง Vault อาจขยับแล้วบางตัวยังไม่ขยับ ผู้ใช้เห็นสถานะ `applying` ตลอด
- `needs_attention`: เมื่อค้างที่ `applying` เกินเวลากำหนด (เริ่มต้น 2 นาที) หรือ `update-ref` ล้มซ้ำ แสดงให้ผู้อนุมัติและ Workspace Admin เห็น; Retry ใช้ได้เสมอ; Abandon ใช้ได้เฉพาะเมื่อยังไม่มี ref ของ Vault ใดขยับ (Undo ส่วน DB ที่ commit แล้วตามกลไก §11.9) ถ้ามี Vault ขยับแล้วให้ Retry จนครบก่อนแล้วค่อย Undo ตามปกติ; Admin ปลดล็อกฉุกเฉินได้พร้อม Security audit
- Stale ตัดสินระดับไฟล์: รายการเป็น Stale เมื่อไฟล์ที่แตะถูกเปลี่ยนบน `main` ตั้งแต่ base sha (ไฟล์อื่นไม่เกี่ยว); ไม่ Auto-merge ในไฟล์เดียวกันแม้คนละบรรทัด เพราะผลลัพธ์เป็นข้อความที่ผู้อนุมัติไม่เคยเห็น; AI สร้างรายการที่ชนใหม่บนข้อความล่าสุดเป็น Proposal Revision ใหม่ให้ตรวจและ Approve ซ้ำ ไม่ Apply เอง
- ร่างของโน้ตเก็บเป็น ref ภายใน (`refs/weft/proposals/<id>`) ไม่มีทางเข้าถึงจากภายนอก
- Idempotency key + Proposal revision ป้องกัน Retry แล้วสร้าง Tasks/Links/commit ซ้ำ
- Existing entity เปลี่ยนหลัง Preview ให้ Stale/Conflict และขอ Refresh diff ไม่ Apply บนข้อมูลใหม่เงียบ ๆ
- AI run Cancel ไม่เท่ากับ Undo สิ่งที่ Commit แล้ว; Cancel หยุด Generation/Tool calls และใช้ Undo group สำหรับผลที่ Apply ไปแล้ว
- Provider run ไม่มีสิทธิ์ตัดสินสำเร็จเอง; Server commit เป็นผู้ตัดสินว่า Applied

### 11.9 AI and history/undo

- AI changes เก็บ Initiator user, Actor type=AI, Provider และ Run/Proposal ID ชัดเจน แยกจาก Human edit แต่ใช้ Operation ledger เดิม
- การ Apply หนึ่ง Proposal เป็น Undoable group ของผู้อนุมัติ พร้อม Bulk precondition checks
- Undo generated tasks ใช้ Archive; ลบ/ย้อนเฉพาะ Relations ที่ Group สร้างและยังไม่มี Intervening conflicting edits
- ถ้ามีคนอื่นแก้ Generated task หรือเพิ่มความสัมพันธ์ที่ทำให้ Undo ไม่ปลอดภัยให้ Conflict ทั้ง Group พร้อมตัวเลือก Review ไม่ Archive งานคนอื่นเงียบ ๆ
- Undo Apply แล้ว Activity ของการเปลี่ยนที่ย้อนหายตามกติกาเดิม แต่ AI run/approval audit ยังอยู่ให้เจ้าของที่มีสิทธิ์ตรวจสอบ
- AI A→B→A Compaction ใช้ Logical actor เดียวกันใน Run/Proposal chain ที่ Eligible ไม่ยุบข้ามคนอื่นหรือคนละ Run โดยไร้ Causality
- User ยังใช้ Mod+Z ได้; เป็น Undo data changes ไม่ใช่ Refund subscription usage หรือยกเลิกอีเมลที่ส่งไปแล้ว

- Undo ของ Proposal ที่ Apply แล้วเป็นการกระทำของมนุษย์ (ผู้อนุมัติ) ไม่ต้องผ่าน Proposal ใหม่: ตรวจเงื่อนไขทั้งกลุ่มก่อน (ฝั่ง Postgres ตามค่าที่คาดไว้ของแต่ละ field; ฝั่ง git ไฟล์ที่ Proposal แตะต้องยังเหมือนที่ `to_sha`) ไม่ตรงข้อใดให้ Conflict ทั้งกลุ่มพร้อมรายการที่ชน ไม่ทำเลยสักส่วน; ถ้าผ่านจึงใช้กลไก Apply เดียวกัน (revert commit ฝั่ง git, inverse ops ฝั่ง DB เช่น Archive งานที่สร้าง); Redo ทำด้วยวิธีเดียวกันภายใต้เงื่อนไขเดียวกัน


### 11.10 Runtime operations and observability

- AI run events: Queued, Running, Waiting for approval, Rate limited, Needs login, Completed, Failed และ Canceled
- Streaming progress แสดง Summary/tool status ไม่เก็บหรือสัญญาว่าจะแสดง Private chain-of-thought
- จำกัด Timeout, Concurrent runs ต่อ User, Queue size, Context size และ Retry budget
- API mode เก็บ Usage/cost เท่าที่ Provider รายงาน; Subscription mode แสดง Usage info ที่ตรวจได้ ไม่ตีราคา Token เป็นยอดเงินที่เรียกเก็บจริง
- Provider availability failure ต้องไม่ทำ Core API/Keyboard actions ช้าหรือใช้ไม่ได้
- Schedule/Background review เป็น Opt-in พร้อม Explicit execution principal, Connection, Scope, Frequency; ผลลัพธ์ส่งได้เฉพาะเป็น Proposal เข้าคิวรอคน Approve ไม่เขียนเอง; ตรวจสิทธิ์ Principal ทุก Run และปิดเมื่อสิทธิ์ถูกถอนหรือ Auth ใช้ไม่ได้
- Schedule ที่ใช้ Global AI ไม่ได้รับสิทธิ์อ่านทั้ง Installation โดยปริยาย ต้องมี User/service principal ที่มี Grants ตาม Scope จริง
- Backup รวม Proposals/Run metadata/Approvals ตาม Retention แต่ไม่ Export Provider credentials

### 11.11 ตัวอย่าง Proposal contract

```json
{
  "schema_version": 1,
  "intent": "split_task",
  "source_task_id": "<existing-task-uuid>",
  "expected_version": 12,
  "drafts": [
    {"draft_id": "api", "title": "Build subscription API", "acceptance_criteria": ["Create and pause a subscription"]},
    {"draft_id": "web", "title": "Build subscription screen", "acceptance_criteria": ["Show subscription status"]},
    {"draft_id": "qa", "title": "Test subscription flow", "acceptance_criteria": ["Cover pause and resume"]}
  ],
  "edges": [
    {"type": "subtask_of", "from_draft": "api", "to_task": "<existing-task-uuid>"},
    {"type": "subtask_of", "from_draft": "web", "to_task": "<existing-task-uuid>"},
    {"type": "subtask_of", "from_draft": "qa", "to_task": "<existing-task-uuid>"},
    {"type": "blocks", "from_draft": "api", "to_draft": "qa"},
    {"type": "blocks", "from_draft": "web", "to_draft": "qa"}
  ],
  "assumptions": ["QA requires both API and Web to be ready"]
}
```

เป็น Payload ตัวอย่าง ไม่ใช่ Model API contract ที่ Implement แล้ว Server ต้องเติม/ตรวจ Project, Scope, Status IDs และ Required attributes ก่อน Apply

ตัวอย่างรายการแก้โน้ตใน Proposal (ไม่ใช่ Model API contract ที่ Implement แล้ว):

```json
{
  "kind": "note_edit",
  "vault": "<vault-uuid>",
  "path": "specs/subscription.md",
  "base_sha": "<file-blob-sha>",
  "operations": [
    {"op": "replace", "find": "Plans are monthly only.", "with": "Plans are monthly or yearly."},
    {"op": "insert_after_heading", "heading": "Billing", "text": "Pausing keeps data for 90 days."}
  ],
  "reason": "Subscription plans now include yearly billing",
  "sources": [{"note": "specs/billing.md", "commit": "<sha>"}]
}
```

### 11.12 Official sources and verification boundary

- [OpenAI: Codex authentication](https://learn.chatgpt.com/docs/auth) — Subscription sign-in กับ API key เป็นคนละ Auth/billing path
- [OpenAI: Codex app-server](https://learn.chatgpt.com/docs/app-server) — Embedded process protocol สำหรับ Agent UX
- [OpenAI: Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) — Structured jobs และ Authentication considerations
- [Anthropic: Run Claude Code programmatically](https://code.claude.com/docs/en/headless) — CLI `-p`, Output modes และ Mode-specific auth constraints
- [Anthropic: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) — การรัน Official binary ในผลิตภัณฑ์และ End-user credentials

ข้อเสนอด้าน Runner/ACL/Proposals เป็นการออกแบบของ Weft ไม่ใช่การรับรอง Integration จากผู้ให้บริการ เงื่อนไข/รุ่น/Plan อาจเปลี่ยน ต้องทดสอบและตรวจเอกสารก่อนออกรุ่นจริง

## 12. Development phases

AI เป็นแกนใน Domain design ตั้งแต่ Phase 0 และผู้ใช้ต้อง Generate/Split/Link ได้ใน Phase 2 ไม่เลื่อนไปท้าย Roadmap จนระบบหลักเสร็จหมด Knowledge ฝั่งอ่าน (Vault, render, ค้นหา) ใช้งานได้ตั้งแต่ Phase 1 ส่วนการที่ AI เสนอแก้ Knowledge และ Apply ข้าม Postgres+git อยู่ Phase 3

| Phase | Release | ผลลัพธ์ |
|---|---|---|
| 0 | Foundation | AI command/ACL/proposal contracts, Rust, Docker, Undo design และ spike ของ git/LFS, HTML sandbox, ค้นหาไทย |
| 1 | alpha-1 Core alpha | Tasks, Customization, Views, History, Team/Assignee, Skills, Knowledge ฝั่งอ่าน, PWA mobile-first และ AI-ready commands |
| 2 | alpha-2 AI planning alpha | Claude/Codex connections, Generate/Split/Link และ Proposal Apply/Undo (AI อ่านและเสนอเท่านั้น) |
| 3 | beta-1 Collaborative beta | Task chat, References, Inbox, Realtime, AI context และ Knowledge ที่ AI แก้ได้ (Apply ข้าม Postgres+git) |
| 4 | beta-2 Planning beta | Milestones, Timeline และ AI-assisted planning/review |
| 5 | 1.0 Stable | AI + Keyboard + Self-hosting + Knowledge ผ่าน End-to-end release gates |

เลขเวอร์ชัน 0.4 ของเอกสารนี้ไม่เกี่ยวกับชื่อ Release ในตาราง Git integration กับ repository ภายนอกยังอยู่นอก Roadmap (Git ใช้เป็นที่เก็บของ Vault ภายในเท่านั้น) ส่วน AI transformation รวมอยู่ในทุก Phase ที่เกี่ยวข้อง

### Phase 0 — Foundation and AI contracts

- [ ] ADRs: Scope, Stack, License, ACL, History, Keyboard modes, git ภายในของ Vault, ลำดับ Apply ข้าม Postgres+git, สิทธิ์ Vault, HTML sandbox และ AI ไม่มี Capability เขียน
- [ ] Rust/Web scaffold, PostgreSQL, CI และ docker/ ตาม Same-origin contract (image มี `git` และ `git-lfs`)
- [ ] Auth/Bootstrap, Workspace และ Permission primitives
- [ ] Task commands, Operation/Undo design และ Proposal/Tool schemas (Proposal ครอบคลุม Task, Link, โน้ต, ไฟล์, Skill, Schema; ไม่มี Pre-authorized policy)
- [ ] Provider feasibility spikes: Codex/Claude Code personal subscription และ Global shared-mode eligibility
- [ ] Connection scopes/default precedence, Central runner ownership และ Global usage policies
- [ ] Runner pairing/isolation design, Billing-mode labels และ Capability matrix
- [ ] Spikes: `git merge-tree --write-tree` และ `git-lfs` บน git ใน image (เช่น 2.39.5), ทิศของ `[[target|alias]]` ใน comrak, CSP/iframe sandbox ในเบราว์เซอร์จริงรวมช่องส่งข้อมูลออก, ค้นหาไทยด้วย `pg_trgm`
- [ ] วัดเพดาน: ขนาด Proposal (รายการ, diff, จำนวน Vault), เวลาล็อก Apply, ขนาดไฟล์ต่อ Vault, จำนวน Tool call/ตัวอักษรต่อรอบ AI, จำนวนและขนาด Skill
- [ ] PWA mobile-first baseline (โครงแท็บล่าง, หน้า Proposal checklist)

**Exit gate:** Clean install และ ACL tests ผ่าน; Provider spikes พิสูจน์ Login/Generate/Cancel/Limit behavior ด้วยบัญชีทดสอบจริง โดยไม่ฝัง Credentials หรืออ้างว่า API billing คือ Subscription; spikes ของ git/LFS/comrak/sandbox/ค้นหาไทยมีผลบันทึกและเพดานที่วัดได้

### Phase 1 — Usable core and AI-ready commands

- [ ] Projects, Tasks, Subtasks, Checklist, Archive และ Version conflicts
- [ ] Custom statuses/Attributes ตั้งแต่ Alpha
- [ ] Table, Kanban, Lists, Smart Lists และ Keyboard/Command palette
- [ ] Visible history, Undo/Redo, Manual-return compaction และ Bulk undo
- [ ] Basic comments, Search, JSON export และ Backup/Restore (รวม Vault repos)
- [ ] Domain tool adapters ใช้ Mock provider ทดสอบ Proposal validation/Apply โดยไม่ต้องรอ Provider จริง
- [ ] Team (ไม่มี role), Assignees เป็นชุด, ปุ่ม รับงาน, Team queue และส่วน ผ่าน Team ใน My work, `@team`
- [ ] Skills ระดับ Workspace (CRUD, History/Undo, Skill เริ่มต้น)
- [ ] Knowledge ฝั่งอ่าน: สร้าง Vault, สมาชิก (ผู้ใช้/Team/Project), Role Viewer/Contributor/Manager, นำเข้า, render Markdown และ HTML inline ที่ sanitize, Backlinks ระหว่างโน้ต, ค้นหาในแท็บ Knowledge, zip export (ไฟล์ `.html` แสดงเป็นซอร์สดิบจนถึง Phase 3)
- [ ] PWA mobile-first ตาม F15 (ติดตั้งได้, แท็บล่าง, หน้า Proposal checklist, focus ครบด้วยคีย์บอร์ดบลูทูธ)

**Exit gate:** Keyboard-only core journey ผ่าน (Desktop) และ Journey หลักบนมือถือ focus ได้ครบ; A→B→A/Undo behavior ถูกต้อง; Proposal schema และ Atomic Task/link creation ผ่าน Integration tests; สิทธิ์ Vault/Team/Project-as-member ผ่านการทดสอบ ACL

### Phase 2 — AI-generated work and task graph

- [ ] weft-agent, Personal/Global runner pairing, Connection settings และ Revoke
- [ ] Global AI setup: Installation/Workspace defaults, Grants, Central queue และ Use team AI UX
- [ ] Codex และ Claude Code adapters พร้อม Subscription/API mode แยก
- [ ] Generate task, Find/open, Suggest split และ Suggest links
- [ ] Editable proposal tree, Partial selection, Typed relation validation และ Reasons
- [ ] Approved apply (Human approve ครั้งเดียว), Idempotency, Stale detection และ Group undo
- [ ] Scoped tools/MCP สำหรับใช้จาก External Claude Code/Codex ตาม Auth contract (อ่านและเสนอเท่านั้น; Approve ที่เว็บ)
- [ ] Streaming/Cancel/Needs-login/Rate-limit UI และ Keyboard coverage
- [ ] Parent/Related/Duplicate/Blocks data model และ Simple relationship list ก่อน Gantt
- [ ] Proposal รวมรายการ Skill และ Schema ได้ (ผู้สั่งต้องมีสิทธิ์นั้น)

**Exit gate:** Global connection ที่ได้รับอนุญาตให้ A/B ใช้ร่วมได้จริงโดย Sessions/ACL ไม่ปน; ทั้งสอง Provider ผ่าน Generate→Review→Create→Link→Undo ด้วย Personal subscription mode ที่รองรับจริง; Model output ผิด Schema/Cycle/ACL ต้อง Apply ไม่ได้; Retry ไม่สร้างซ้ำ; Runner offline และ Quota limit ไม่ทำ Core ล่ม; ไม่มีเส้นทางใดที่ AI Apply เองโดยไม่มีคนกด Approve

### Phase 3 — Collaboration and context

- [ ] Comments, Mentions, Files, Reactions, Quote/reply และ Create task from message
- [ ] #references, Backlinks, Safe previews และ Search description/comments
- [ ] Realtime Task/History/Proposal/Run events และ Reconnect reconciliation
- [ ] Watchers, Inbox, Notification compaction และ Optional SMTP
- [ ] AI context selection จาก Task chat/Tasks ที่เกี่ยวข้องพร้อม Sources
- [ ] Duplicate suggestions, Task quality review และ Summaries
- [ ] JSON import/Dry run และ External client ACL regression
- [ ] Knowledge ที่ AI แก้: `search_notes`, `read_note`, `propose_note_edit`, `propose_file_add`; Apply ข้าม Postgres+git (ล็อก Vault, Recovery job, `needs_attention`); Undo ด้วย revert commit; Git LFS ตามกติกา F12
- [ ] หน้า `.html` ทั้งไฟล์ที่รัน JavaScript ในกรอบกัก พร้อมป้าย มีสคริปต์ และตัวอย่างใน Proposal
- [ ] Task อ้างโน้ต (Reference ทางเดียว, Chip, ติดตามการเปลี่ยนชื่อ)
- [ ] ตัดสินเรื่องการแจ้งเตือนเมื่อ Knowledge เปลี่ยน (Inbox/Watchers) เมื่อมี Inbox แล้ว

**Exit gate:** สอง Browser เห็น State/Undo ตรงกัน; Reference/AI retrieval ไม่รั่ว Restricted sources (รวมโน้ตใน Vault); ถอนสิทธิ์ระหว่าง Run แล้ว Apply/Tools ถูกปฏิเสธ; Apply ข้าม Postgres+git ที่พังกลางทางกู้ต่อได้และไม่เงียบ; หน้า HTML ถูกกักและไม่ส่งข้อมูลออกภายนอกตามที่ทดสอบได้; Whole journey ใช้ Keyboard ได้

### Phase 4 — Planning and AI transformation workflows

- [ ] Milestones, Project overview, Calendar, Timeline และ Blocker views
- [ ] AI-assisted sequencing, Milestone proposals และ Progress review
- [ ] Advanced Smart Lists, Templates, Recurrence และ CSV export
- [ ] Opt-in scheduled reviews ที่ส่งได้เฉพาะ Proposal เข้าคิวรอคน Approve พร้อม Connection owner/Scope/Limits
- [ ] Emergency disable ของ Schedule และ AI connection
- [ ] Keyboard equivalents สำหรับทุก Drag/Resize/Date/Graph action

**Exit gate:** Goal→Milestones→Linked tasks→Review ทำงานได้ครบ; Cycle/Timezone/Recurrence tests ผ่าน; Schedules ไม่ใช้ Auth คนอื่น ไม่เขียนเอง และหยุดเมื่อ Revoke

### Phase 5 — Stable open-source release

- [ ] Per-provider version/plan support matrix ที่ทดสอบจริงและ Setup documentation
- [ ] Security review: Runner pairing, Prompt injection, Tokens, ACL, Proposal TOCTOU, HTML sandbox และ Proposal ข้าม Postgres+git
- [ ] Keyboard-only E2E, IME/focus checks และ Multi-user undo conflicts
- [ ] Load tests, Provider failure drills และ Queue backpressure
- [ ] Docker clean install/upgrade, Single-origin tests และ Backup/Restore รวม AI metadata
- [ ] Restore drill ที่พิสูจน์ว่า Postgres, Vault repos และ LFS objects สอดคล้องกัน; LFS garbage collection
- [ ] Explicit retention/purge (รวมการลบ secret ที่หลุดออกจากประวัติ git ของ Vault), Credentials exclusion และ Contribution/License/Security docs
- [ ] ทดลองกับทีมจริงครบหนึ่งรอบการวางแผนและส่งมอบ

**Exit gate:** ผู้ใช้ภายนอกติดตั้ง Core และตั้ง Global AI หรือ Personal AI ได้จากคู่มือ; AI ล่มแล้ว Core ยังใช้ได้; ไม่มี Unauthorized credential sharing/Unauthorized writes/Data-loss issues ค้าง; ประกาศข้อจำกัดจริงของ Provider modes

## 13. Tests and measurable acceptance targets

### Required regression scenarios

1. เปลี่ยน Status → Undo → Redo แล้วข้อมูล, Timeline และ Task versions ถูกต้อง
2. Title/Description/Custom attribute A→B→A แล้ว Visible history ยุบ
3. คนอื่นแก้ Field เดียวกันคั่นแล้วไม่ยุบข้าม และ Undo conflict ปลอดภัย
4. คนอื่นแก้คนละ Field แล้วยัง Undo ของตนได้เมื่อ Preconditions ตรง
5. Bulk undo Conflict หนึ่งงานแล้วไม่เกิด Partial apply แบบเงียบ
6. Undo/Reapply Description ที่มี #reference แล้ว Backlinks, Counts และ Preview ถูกต้อง
7. Undo แล้ว Refresh/Reconnect/Restore ไม่ทำ Log ที่ Suppressed กลับมา
8. Mention/Reference ที่อ่านไม่ได้ไม่รั่ว Title/Snippet/Count ผ่าน UI/API/WS
9. Full keyboard journeys รวม IME, Focus restore, Table virtualization และ Native text undo
10. Docker clean install/upgrade และ Same-origin asset/API/WS/File requests
11. Custom status/attribute rename/archive แล้ว Filters และงานเดิมยังถูกต้อง
12. Backup/Restore รักษา Current state, Operation links, ACL และ Attachments

13. Claude/Codex Subscription smoke tests แยกจาก API-key tests; Billing mode ไม่สลับเอง
14. Generate/split/link ที่มี Draft IDs กับ Existing IDs Apply Atomic และ Retry ไม่สร้างซ้ำ
15. Partial proposal approval ไม่ทิ้ง Dangling links; Cycles/Invalid attributes/Unauthorized targets ถูกปฏิเสธ
16. Proposal stale หลังคนอื่นแก้งานหรือถอนสิทธิ์ต้อง Apply ไม่ได้
17. AI group undo ไม่ Archive งานที่คนอื่นแก้ต่อโดยไม่ตรวจ Conflict
18. Prompt injection ไม่อ่าน Host secrets ไม่เรียก Shell ไม่เพิ่ม Tool grants และไม่ข้าม ACL
19. Runner pair/revoke/lease/owner isolation และ Reconnect ไม่รับงานของคนอื่น
20. Provider offline, Quota/timeout/cancel และ API billing choice ไม่ทำ Core tasks ล่ม
21. Global AI ตั้งครั้งเดียวแล้ว A/B ใช้ได้ แต่ Prompts/Sessions/Context ไม่ปนและ Tools ใช้ ACL ของ Initiator
22. Global grants/default precedence/disable/rotation และ User revocation ระหว่าง Run ถูกต้อง
23. Global concurrency/fair queue/Per-user budgets ทำงานและไม่ Fallback ไปค่าใช้จ่ายอื่นโดยเงียบ
24. Global subscription ที่ไม่มี Entitlement ต้องไม่ขึ้น Shared ready หรือดึง Personal credential มา Pool
25. Apply ที่พังกลางทาง (เช่น หลัง Postgres commit ก่อน `update-ref`) กู้ต่อด้วย Recovery job ได้ ไม่ roll back git และขึ้น `needs_attention` เมื่อค้างเกินเวลา
26. Stale ระดับไฟล์: ไฟล์ที่ Proposal แตะถูกเปลี่ยนบน `main` ทำให้รายการ Stale และ AI สร้าง Revision ใหม่ให้ Approve ซ้ำ ไม่ Auto-merge; ไฟล์อื่นที่ไม่ชนไม่ Stale
27. ล็อก Vault ระหว่าง Apply: Proposal อื่นบน Vault เดียวกันรอคิว, ล็อกข้ามหลาย Vault เรียงตาม id ไม่ deadlock, Admin ปลดล็อกฉุกเฉินมี Audit
28. Undo ของ Proposal ที่แตะ Postgres+git: ตรวจทั้งกลุ่มก่อน Conflict ทั้งกลุ่มถ้าไฟล์ถูกแก้ต่อ ไม่ทำบางส่วน; Redo ทำงานภายใต้เงื่อนไขเดียวกัน
29. AI ไม่มีทาง Apply: ไม่มี Tool/token/MCP ที่เรียก Approve ได้ และไม่มี Pre-authorized policy
30. สิทธิ์ Vault: Viewer/Contributor/Manager, สมาชิกแบบผู้ใช้/Team/Project (Project ให้สิทธิ์ทางเดียว), Workspace Viewer เพดานอ่านอย่างเดียว, Admin เห็นรายชื่อไม่เห็นเนื้อหา
31. Team: ถอนสมาชิก/ถอน grant มีผลทันทีรวม AI run ที่กำลังทำงาน; `list_teams` ไม่รั่ว grants; `@team` แจ้งเฉพาะผู้อ่าน Task ได้; Assignee ชุด และปุ่ม รับงาน ย้อนด้วย Undo ได้
32. Skills: อ่านได้ทั้ง Workspace, แก้เฉพาะ Admin, Skill ไม่เพิ่มสิทธิ์, AI เสนอแก้ได้เฉพาะเมื่อผู้สั่งมีสิทธิ์
33. HTML: allowlist ตัดแท็ก/attribute ที่ห้ามออก; หน้า `.html` ได้ header sandbox/CSP ถูกต้องแม้เปิด URL ตรง; ไม่เห็น cookie/API ของแอป; ไม่มี request ออกภายนอกจากหน้านั้นตามที่ทดสอบได้ (รวมบันทึกช่องที่ CSP ไม่ครอบคลุม)
34. Link resolution ตามกฎ 4 ข้อ (path เต็ม, ชื่อไม่สนตัวพิมพ์/alias, ใกล้โฟลเดอร์ที่สุด, ป้ายกำกวม, ไม่พบ), รวมกรณีเปลี่ยนชื่อไฟล์และ Reference จาก Task ตามไปด้วย
35. ค้นหาโน้ต: กรองตามสมาชิก Vault ทั้งผลลัพธ์ จำนวน และ Snippet; ภาษาไทยทดสอบ Exact/Substring; ไฟล์ Binary ค้นได้เฉพาะชื่อ
36. LFS: ไฟล์ Binary ถูกเก็บเป็น pointer + object, `.gitattributes` สอดคล้อง, Import ไม่เขียนประวัติใหม่, Backup/Restore รักษา `.git/lfs`
37. มือถือ: ทุก control และแถว focus ได้ด้วยคีย์บอร์ดบลูทูธ, Bottom sheet คืน Focus, หน้า Proposal ตัดรายการพึ่งกันออกพร้อมกันและปุ่ม Approve ปิดเมื่อมี Stale

### Test layers

- Unit: Equality normalization, History projection, Reference parser และ Progress
- PostgreSQL integration: ACL, Transactions, Concurrent operations และ Constraints
- API contract: Validation, Pagination, Undo eligibility และ Idempotency
- Browser E2E: Keyboard-only + Multi-browser collaboration + Network interruption
- Operations: Docker install, Proxy routes, Backup/Restore และ Version upgrades
- AI evaluations: Task completeness, Correct split, Valid typed links, Sources และ Human acceptance บนชุดตัวอย่างภาษาไทย/อังกฤษ
- Provider adapters: Mock deterministic tests ใน CI; Official account smoke tests แบบ Opt-in แยก ไม่เก็บ Subscription credentials ใน Public CI
- Knowledge: ทดสอบกับ Vault ตัวอย่าง (มี `.obsidian/`, ไฟล์ Binary, ชื่อไฟล์ซ้ำ, ภาษาไทย/อังกฤษ), ทดสอบ sandbox ในเบราว์เซอร์จริง และ Fault injection ระหว่าง Apply ข้าม Postgres+git

### Performance targets — ต้องวัดก่อนรับรอง

| หัวข้อ | เป้าหมายเริ่มต้น |
|---|---|
| Reference machine | 4 vCPU, RAM 8 GB, SSD, App + PostgreSQL |
| Dataset | 100k Tasks, 500k Comments และ Operation ledger ตาม Workload ที่บันทึก |
| Concurrent clients | 30 Active clients, Mixed read/write |
| Paginated task reads | p95 ≤ 400 ms Server time สำหรับ Query ที่กำหนด |
| Normal mutation / single-task undo | p95 ≤ 500 ms Server time |
| Realtime propagation | p95 ≤ 1 วินาทีหลัง Commit บน LAN |
| Knowledge Apply และ Index | วัดใน Phase 0: เวลาล็อก Apply ต่อ Vault, เวลา Reindex ทั้ง Vault, เวลา Preflight ต่อขนาด Proposal; ไม่ใช้ตัวเลขเป้าหมายแทนผลวัด |

ต้องระบุ Data distribution, Cache state, Query shapes, Ledger size และ Error rate ในผลวัด ไม่ใช้ตัวเลขเป้าหมายแทนผล Benchmark

## 14. Definition of Done

- [ ] ตรง Requirement/Phase และมี Acceptance tests ที่ตรวจพฤติกรรมสำคัญ
- [ ] Server-side ACL ครบทุกช่องทางและไม่มีข้อมูลข้าม Workspace
- [ ] ทุก Action มี Keyboard route พร้อม Focus/IME behavior
- [ ] Field mutations รองรับ History/Undo/No-op ตามขอบเขต หรือมีเหตุผลชัดเจนว่าไม่รองรับ
- [ ] Reference index, Activity projection และ Notifications สอดคล้องกับ Undo/Compaction
- [ ] มี Loading/Empty/Error/Conflict states และรักษา Draft เมื่อ Error
- [ ] Database migration, Constraints และ Index ที่จำเป็นครบ
- [ ] Realtime ใช้ Update/Remove events ถูกต้อง ไม่ Append อย่างเดียว
- [ ] Frontend/API/Files/WS อยู่ Public origin เดียว
- [ ] อัปเดตคู่มือผู้ใช้/ผู้ดูแลและ docker/ เมื่อมีผลต่อการติดตั้ง
- [ ] AI tool coverage, ACL, Proposal validation, Billing mode และ Undo behavior ผ่านกรณีที่เกี่ยวข้อง
- [ ] AI data/tools ไม่เกินสิทธิ์ Initiator แม้ใช้ Global connection; ไม่ส่ง Context เกินที่เลือก และไม่เปิด Credential ให้ User
- [ ] ไม่มีเส้นทางใดที่ AI/token/MCP เขียนหรือ Apply เองโดยไม่มีคนกด Approve ผ่านเว็บ
- [ ] Knowledge: การ Apply ข้าม Postgres+git กู้ต่อได้ ไม่เงียบ และ Undo ตรวจทั้งกลุ่มก่อน
- [ ] HTML ใน Vault ถูก sanitize/กักตามกฎ §10 และมีผลทดสอบเบราว์เซอร์จริง
- [ ] ทุกหน้าที่เพิ่มรองรับมือถือ (focus ครบ) และไม่ต้องมี Markdown editor
- [ ] สิทธิ์ Vault/Team/Project-as-member ถูกบังคับฝั่ง server ทุกช่องทางรวม AI tools

## 15. First implementation backlog

| ลำดับ | Deliverable | เหตุผล |
|---|---|---|
| 1 | ADR: AI-first scope, ACL, History, Runner, Keyboard modes, git ภายในของ Vault, ลำดับ Apply และ HTML sandbox | ล็อกพฤติกรรมที่กระทบโครงสร้าง |
| 2 | Rust/Web skeleton + docker/ (มี `git` และ `git-lfs`) + PostgreSQL | เปิดระบบผ่าน Origin เดียวได้ |
| 3 | Auth, Workspace, Project ACL และ Team | ป้องกันข้อมูลก่อนเพิ่มหน้าจอ และ Assignee ชุดอาศัย Team |
| 4 | Task commands + Operations + Undo + Proposal validation (ทุกชนิดรายการ) | UI และ AI ใช้กติกาเดียวกัน |
| 5 | Custom statuses และ Attributes | เป็นฟีเจอร์หลักตั้งแต่ Alpha |
| 6 | Table, Task panel, Keyboard primitives และ PWA mobile shell | ใช้งานทุกวันได้เร็วทั้งมือถือและ Desktop |
| 7 | Lists, Smart Lists และ Kanban | หลายมุมมองบนงานเดียว |
| 8 | Skills และ Vault ฝั่งอ่าน (สมาชิก, นำเข้า, render, ค้นหา) | สอน AI ระบบ และให้ Knowledge ใช้ได้เร็ว |
| 9 | Global/Personal Claude/Codex runner + Generate/Split/Link | ตั้ง AI กลางให้ทีมใช้ หรือใช้บัญชีตนเองได้ |
| 10 | Comments, References, Realtime และ Inbox | Collaboration, AI context และ Undo ข้าม Client |
| 11 | AI แก้ Knowledge + Apply ข้าม Postgres+git + หน้า HTML ในกรอบกัก | ปิดวง Knowledge โดยมีคนอนุมัติทุกครั้ง |
| 12 | Milestones และ Timeline | ขยายไปการวางแผนส่งมอบ |

## 16. Decision log and revision notes

### v0.4 — 29 October 2026

- เพิ่ม Knowledge: Vault ที่ใช้ git ภายในเป็นที่เก็บเวอร์ชัน (เฉพาะ Weft commit, ไม่มี endpoint git/token/push), Markdown แบบ Obsidian + HTML, Git LFS สำหรับไฟล์ที่ไม่ใช่ข้อความ, ผู้ใช้ไม่แก้โน้ตตรง ๆ แต่ให้ AI เสนอแล้ว Approve; ยกเลิกข้อห้าม Documents/Wiki ของ v0.3 (ยังไม่ทำ Real-time co-editing)
- ทุกการเขียนโดย AI เป็น Proposal เดียวที่เตรียมครบและ Approve ครั้งเดียว; AI ไม่มี Capability เขียนหรือ `apply_proposal`; ลบ Pre-authorized policy และ Batch ซ่อน; เพิ่มลำดับ Apply ข้าม Postgres+git, ล็อก Vault, `needs_attention`, Stale ระดับไฟล์ และ Undo ทั้งกลุ่ม
- เพิ่ม Team (ไม่มี role) และ Assignee เป็นชุดของผู้ใช้/Team พร้อมปุ่ม รับงาน; เพิ่ม Vault membership แบบ Project (ผู้ใช้/Team/Project, Viewer/Contributor/Manager)
- เพิ่ม Skill ระดับ Workspace ที่แก้บนเว็บ ส่งถึง AI ผ่าน tool และไม่ให้สิทธิ์
- เปลี่ยนเป็น Mobile-first PWA (ไม่ใช่ native app) พร้อม Full keyboard บน Desktop และ focus-complete บนมือถือ
- เพิ่มหน้า `.html` ที่รัน JavaScript ในกรอบกัก (sandbox + CSP บน origin เดียว) ลดความเสี่ยงแต่ไม่รับประกัน
- เปลี่ยนชื่อ Release ในตาราง Phase เป็น alpha-1, alpha-2, beta-1, beta-2 และ 1.0; Knowledge ฝั่งอ่านอยู่ Phase 1 และ AI แก้ Knowledge อยู่ Phase 3
- เลื่อนไปอนาคต: Skill ระดับ Team/ส่วนตัว, Team Lead/ซ้อนทีม, ส่ง Vault ขึ้น git host ภายนอกและ clone แบบอ่านอย่างเดียว, re-import จากสำเนา Obsidian, ลด Project role เป็นอ่าน/เขียน, JavaScript ที่ซับซ้อนกว่าเดิมในหน้า HTML
- ที่มา: ADR ที่เกี่ยวข้องเก็บใน `docs/adr/`; v0.3 ฉบับเดิมเก็บเพื่ออ้างอิงที่ `docs/specs/product-spec-v0.3.md`


### v0.3 — 29 October 2026

- ให้ AI transformation เป็นแกน Product โดยคง Height 1.0/GitHub UX, Keyboard และ Undo
- เพิ่ม Claude Code/Codex adapters, Global/Workspace/Personal connections และ Isolated runners
- เพิ่ม Generate, Split, Typed links, Editable proposals, Apply/Undo และ Scoped MCP tools
- ย้าย AI planning มา Phase 2 และขยาย Roadmap เป็น Phase 0–5
- Documents และ Git repository integrations ยังคงตัดออก

### v0.2 — 29 October 2026 (historical scope, superseded by v0.3 where changed)

- เปลี่ยนเป้าหมายเป็น Height 1.0 + GitHub-style issue UX
- ตัด Git integrations, Documents, AI และ Integration roadmap เดิมออก
- เพิ่ม History compaction, Undo/Redo และ Manual return-to-original rules อย่างละเอียด
- ย้าย Custom statuses/Attributes มา Core alpha
- เปลี่ยน Required deployment folder จาก deploy/ เป็น docker/
- กำหนด Domain เดียวสำหรับ Web/API/WS/Files และ Production image รวม Frontend assets
- เปลี่ยน Keyboard support จาก Basic shortcuts เป็น Full keyboard release requirement
- เพิ่ม #Task references, Backlinks และ Permission-safe previews
- ลด Roadmap เหลือ Phase 0–4 และจบที่ Stable v1.0 ของ Core product

### ต้องยืนยันก่อน Public release

- License ที่เสนอและ Name availability
- Rust backend + TypeScript frontend ตามข้อเสนอ หรือใช้ Rust frontend
- Supported Browser/OS/CPU architectures ที่ทดสอบจริง
- Internal operation retention/checkpoint policy และผลต่อ Undo eligibility
- Default shortcut bindings จากผล Keyboard-only usability testing
- Supported provider versions/auth modes และผล Subscription smoke tests
- Defaults สำหรับ AI context, Approval policy, Run retention และ Personal/Global runner deployment
- Provider entitlements สำหรับ Global shared use และ Organization-owned credentials
- ทิศของ `[[target|alias]]` ใน comrak และการจับคู่กฎ resolve ลิงก์กับตัวอย่างจริงของ Obsidian
- พฤติกรรมของ `git merge-tree --write-tree`, `git-lfs` และ `git` ที่ติดใน image (เช่น 2.39.5 บน Debian bookworm) ไม่ใช่แค่เอกสารรุ่นใหม่
- ผลทดสอบ CSP/iframe sandbox ในเบราว์เซอร์จริง รวมช่องส่งข้อมูลออกที่ CSP ไม่ครอบคลุม (WebRTC, DNS prefetch, ลิงก์ที่ผู้ใช้กดเอง)
- พฤติกรรมค้นหาภาษาไทยด้วย `pg_trgm` และเพดานที่วัดได้ (ขนาด Proposal, เวลาล็อก Apply, ขนาดไฟล์, จำนวน Tool call/ตัวอักษรต่อรอบ, ขนาด Skill)
- ดีไซน์ LFS garbage collection และ retention/purge ประวัติ git เมื่อมี secret หลุด
- ค่าเริ่มต้น role ของ Member ใน Project แบบ Workspace-visible และตารางสิทธิ์ระดับ Workspace เต็ม (v0.3 ยังไม่ระบุ)

**Implementation starting point:** Phase 0 → Phase 1 → Phase 2 โดยพิสูจน์ AI connection feasibility, History/Undo, Keyboard UX, spike ของ git/LFS/HTML sandbox และ Generate/Split/Link ตั้งแต่ต้น; Knowledge ฝั่งอ่านใน Phase 1 และ AI แก้ Knowledge ใน Phase 3
