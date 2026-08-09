// Supabase Edge Function: send-notification
// ============================================================
// Deploy with: supabase functions deploy send-notification
// Then set two secrets (never put these in client code):
//   supabase secrets set VAPID_PUBLIC_KEY=<your public key>
//   supabase secrets set VAPID_PRIVATE_KEY=<your private key>
//   supabase secrets set VAPID_SUBJECT=mailto:you@example.com
//
// This function is meant to be called two ways:
//  1. By a Supabase Database Webhook, pointed at this function, on:
//       - INSERT on calendar_events      -> type "calendar_event"
//       - UPDATE on meet_entries         -> type "meet_entry_decision"
//       - INSERT on meet_entries         -> type "meet_entry_override_needed"
//       - INSERT on workouts             -> type "new_workout"
//     Database Webhooks send the standard payload shape
//     { type, table, record, old_record, schema } automatically --
//     this function reads that shape directly, no extra config needed
//     beyond pointing the webhook at each table in the dashboard.
//  2. By a scheduled Supabase Cron job (Database > Cron Jobs), calling
//     this function directly with a custom body like:
//       { "type": "attendance_reminder", "team_id": "YOURTEAMCODE" }
//     once a day at whatever time practices usually start.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function sendToUsers(userIds: string[], notificationType: string, title: string, body: string, url = "/") {
    if (!userIds.length) return { sent: 0, skipped: 0 };
    const uniqueIds = [...new Set(userIds)];

    // Only notify users who (a) have this notification type enabled
    // (default-on if they've never touched their preferences) and
    // (b) have at least one active push subscription.
    const { data: prefsRows } = await supabase
        .from("notification_preferences")
        .select("user_id, prefs")
        .in("user_id", uniqueIds);

    const disabled = new Set(
        (prefsRows || [])
            .filter((r: any) => r.prefs && r.prefs[notificationType] === false)
            .map((r: any) => r.user_id)
    );
    const eligibleIds = uniqueIds.filter((id) => !disabled.has(id));
    if (!eligibleIds.length) return { sent: 0, skipped: uniqueIds.length };

    const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("*")
        .in("user_id", eligibleIds);

    let sent = 0;
    for (const sub of subs || []) {
        try {
            await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
                JSON.stringify({ title, body, url, icon: "icon.png" })
            );
            sent++;
        } catch (err: any) {
            // A 404/410 means the subscription is dead (uninstalled, expired) -- clean it up.
            if (err.statusCode === 404 || err.statusCode === 410) {
                await supabase.from("push_subscriptions").delete().eq("id", sub.id);
            } else {
                console.error("Push send error:", err.message);
            }
        }
    }
    return { sent, skipped: uniqueIds.length - eligibleIds.length };
}

async function resolveParentIds(swimmerId: string): Promise<string[]> {
    const { data } = await supabase.from("parent_links").select("parent_user_id").eq("swimmer_id", swimmerId);
    return (data || []).map((r: any) => r.parent_user_id);
}

async function resolveCoachIdsForGroup(teamId: string, groupName: string | null): Promise<string[]> {
    // Owner/admin always included; group-assigned coaches included if
    // groupName is set. If groupName is null (team-wide item), every
    // coach/admin/owner on the team is notified.
    const { data: members } = await supabase.rpc("get_team_members", { p_team_id: teamId });
    const staff = (members || []).filter((m: any) => ["coach", "admin", "owner"].includes(m.role));

    if (!groupName) return staff.map((m: any) => m.id);

    const { data: links } = await supabase
        .from("coach_group_links")
        .select("coach_user_id")
        .eq("team_id", teamId)
        .eq("group_name", groupName);
    const assignedIds = new Set((links || []).map((r: any) => r.coach_user_id));

    return staff
        .filter((m: any) => m.role === "owner" || m.role === "admin" || assignedIds.has(m.id))
        .map((m: any) => m.id);
}

async function resolveParentIdsForGroup(teamId: string, groupName: string | null): Promise<string[]> {
    let query = supabase.from("swimmers").select("id, group_name").eq("team_id", teamId);
    if (groupName) query = query.eq("group_name", groupName);
    const { data: swimmers } = await query;
    const swimmerIds = (swimmers || []).map((s: any) => s.id);
    if (!swimmerIds.length) return [];
    const { data: links } = await supabase.from("parent_links").select("parent_user_id").in("swimmer_id", swimmerIds);
    return (links || []).map((r: any) => r.parent_user_id);
}

// Returns "HH:MM" (24-hour) for the current time in the given IANA
// timezone -- using Intl instead of manual UTC offset math means
// this handles DST transitions automatically.
function currentTimeInTimezone(timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${hour}:${minute}`;
}

// Returns "YYYY-MM-DD" for "today" in the given timezone -- matters
// near midnight, where UTC's date and the team's local date can differ.
function todayInTimezone(timeZone: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

function addMinutesToTimeStr(timeStr: string, minutesToAdd: number): string {
    const [h, m] = timeStr.split(":").map(Number);
    let total = ((h * 60 + m + minutesToAdd) % 1440 + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

Deno.serve(async (req) => {
    try {
        const payload = await req.json();

        // -------- Manual/cron call: attendance reminder --------
        // Runs frequently (every ~15 min via Cron Job) rather than once a
        // day at a fixed time, because each group can have its own
        // practice_start_time -- this checks whether 30 minutes have
        // passed since THAT group's own start time, in the team's local
        // timezone, and only sends once per group per day
        // (last_attendance_reminder_date guards against repeat sends on
        // every poll).
        if (payload.type === "attendance_reminder") {
            const teamId = payload.team_id;
            const TEAM_TIMEZONE = "America/New_York"; // change if your team is in a different timezone
            const today = todayInTimezone(TEAM_TIMEZONE);
            const nowTime = currentTimeInTimezone(TEAM_TIMEZONE);

            const { data: groups } = await supabase
                .from("team_groups")
                .select("id, name, practice_start_time, last_attendance_reminder_date")
                .eq("team_id", teamId)
                .not("practice_start_time", "is", null);
            const { data: todaysAttendance } = await supabase
                .from("attendance")
                .select("swimmer_id")
                .eq("team_id", teamId)
                .eq("practice_date", today);
            const { data: swimmers } = await supabase.from("swimmers").select("id, group_name").eq("team_id", teamId);

            const markedSwimmerIds = new Set((todaysAttendance || []).map((a: any) => a.swimmer_id));
            let totalSent = 0;

            for (const g of groups || []) {
                if (g.last_attendance_reminder_date === today) continue; // already sent today

                const reminderDueAt = addMinutesToTimeStr(String(g.practice_start_time).slice(0, 5), 30);
                if (nowTime < reminderDueAt) continue; // not due yet today

                const groupSwimmerIds = (swimmers || []).filter((s: any) => s.group_name === g.name).map((s: any) => s.id);
                if (!groupSwimmerIds.length) continue;
                const anyMarked = groupSwimmerIds.some((id: string) => markedSwimmerIds.has(id));
                if (anyMarked) continue; // attendance already started for this group today

                const coachIds = await resolveCoachIdsForGroup(teamId, g.name);
                const result = await sendToUsers(coachIds, "attendance_reminder", "Attendance Reminder", `${g.name} attendance hasn't been taken yet today.`, "/");
                totalSent += result.sent;

                await supabase.from("team_groups").update({ last_attendance_reminder_date: today }).eq("id", g.id);
            }
            return new Response(JSON.stringify({ ok: true, sent: totalSent }), { headers: { "Content-Type": "application/json" } });
        }

        // -------- Database Webhook calls --------
        const { table, type: eventType, record } = payload;

        if (table === "calendar_events" && eventType === "INSERT") {
            if (record.visibility !== "team") {
                return new Response(JSON.stringify({ ok: true, skipped: "non-team visibility" }));
            }
            const parentIds = await resolveParentIdsForGroup(record.team_id, record.group_name);
            const coachIds = await resolveCoachIdsForGroup(record.team_id, null); // calendar events notify all coaches regardless of group
            const targetIds = [...parentIds, ...coachIds].filter((id) => id !== record.created_by);
            const result = await sendToUsers(targetIds, "calendar_event", record.title, `New on the calendar${record.group_name ? " for " + record.group_name : ""}: ${record.start_date}`, "/");
            return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
        }

        if (table === "meet_entries" && eventType === "UPDATE") {
            if (record.status === "pending_coach_approval") {
                return new Response(JSON.stringify({ ok: true, skipped: "not yet decided" }));
            }
            const parentIds = await resolveParentIds(record.swimmer_id);
            const verb = record.status === "approved" ? "approved" : "declined";
            const result = await sendToUsers(parentIds, "meet_entry_decision", "Meet Entry Update", `Your swimmer's meet entry was ${verb}.`, "/");
            return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
        }

        if (table === "meet_entries" && eventType === "INSERT") {
            if (record.status !== "pending_coach_approval") {
                return new Response(JSON.stringify({ ok: true, skipped: "auto-approved, no review needed" }));
            }
            const { data: swimmer } = await supabase.from("swimmers").select("team_id, group_name").eq("id", record.swimmer_id).single();
            const coachIds = swimmer ? await resolveCoachIdsForGroup(swimmer.team_id, swimmer.group_name) : [];
            const result = await sendToUsers(coachIds, "meet_entry_override_needed", "Meet Entry Needs Review", "A parent's meet entry needs a manual time override.", "/");
            return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
        }

        if (table === "workouts" && eventType === "INSERT") {
            if (record.visibility === "private") {
                return new Response(JSON.stringify({ ok: true, skipped: "private workout" }));
            }
            const groupName = record.visibility === "public" ? null : record.group;
            const coachIds = (await resolveCoachIdsForGroup(record.team_id, groupName)).filter((id) => id !== record.created_by);
            const result = await sendToUsers(coachIds, "new_workout", "New Workout Posted", record.title, "/");
            return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
        }

        if (table === "coach_announcements" && eventType === "INSERT") {
            const parentIds = await resolveParentIdsForGroup(record.team_id, record.group_name);
            const result = await sendToUsers(parentIds, "coach_announcement", record.title, record.body, "/");
            return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
        }

        if (table === "conversation_messages" && eventType === "INSERT") {
            const { data: convo } = await supabase.from("conversations").select("parent_user_id").eq("id", record.conversation_id).single();
            if (!convo) return new Response(JSON.stringify({ ok: true, skipped: "conversation not found" }));

            let targetIds: string[] = [];
            let title = "New Message";
            if (record.sender_role === "parent") {
                // Notify every coach on the team -- shared inbox model.
                targetIds = await resolveCoachIdsForGroup(record.team_id, null);
                title = "New Message From a Parent";
            } else {
                // A coach replied -- notify just that one family.
                targetIds = [convo.parent_user_id];
                title = "Coach Replied";
            }
            targetIds = targetIds.filter((id) => id !== record.sender_id);
            const result = await sendToUsers(targetIds, "conversation_message", title, record.body, "/");
            return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
        }

        return new Response(JSON.stringify({ ok: true, skipped: "no matching handler for this table/event" }), { headers: { "Content-Type": "application/json" } });
    } catch (err: any) {
        console.error(err);
        return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
});
