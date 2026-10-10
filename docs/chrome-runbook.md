# מדריך עבודה עם Claude בכרום: LALUMap

סדר הביצוע: חלק א (GitHub) ואז חלק ב (Supabase והשאר). כל שלב כולל: הקישור לעמוד, מה עושים ולמה, הנחיה להדבקה ב-Claude בכרום, ותנאי עצירה.
צעדים שמסומנים "טרמינל" או "בצ'אט" אינם נעשים בכרום.

## הנחיית בסיס: הדבק פעם אחת בתחילת כל שיחה עם Claude בכרום

```
אני ד״ר עו״ד אברהם ללום ואני מחובר לחשבונות. בצע רק את הצעדים שאכתוב.
כללים: (1) לפני כל לחיצה על כפתור שמוחק, ממזג, משנה הגדרות אבטחה או מאשר עלות, עצור, תאר לי מה אתה עומד ללחוץ וחכה שאכתוב "אשר".
(2) אל תקליד סיסמאות, קודי אימות או מפתחות. אם מתבקש, עצור וקרא לי.
(3) אם המסך שונה ממה שתיארתי, עצור, תאר מה אתה רואה ושאל.
(4) בסוף כל שלב דווח: מה בוצע, מה כתוב על המסך כעת, וכל הודעת שגיאה במלואה.
```

---

## חלק א: GitHub (15 דקות)

### א1. ברירת המחדל של הריפו הופכת ל-main

- עמוד: https://github.com/lalomavi-collab/LALUMap/settings/branches
- למה: כרגע ברירת המחדל היא ענף ישן (`claude/customer-notification-rea-failure-u8x03o`). `main` נוצר מאותו קומיט בדיוק, ולכן המעבר לא משנה שום תוכן.
- הנחיה ל-Claude בכרום:
```
פתח https://github.com/lalomavi-collab/LALUMap/settings/branches .
תחת "Default branch" קרא ואמור לי מה הענף הנוכחי. לחץ על סמל ההחלפה (שני חצים) לידו, בחר "main", ולחץ "Update".
כשמופיע חלון אישור, עצור והצג לי את הטקסט שבו. אחרי שאכתוב "אשר", לחץ "I understand, update the default branch".
בסוף רענן את העמוד ואשר שתחת "Default branch" כתוב "main".
```
- תנאי הצלחה: כתוב `main` תחת Default branch.

### א2. הגנה על main

- עמוד: https://github.com/lalomavi-collab/LALUMap/settings/rules/new?target=branch
- למה: אחרי ההגנה אי אפשר לדחוף ישירות ל-`main` או למחוק אותו, וכל שינוי עובר PR עם בדיקות ירוקות. אוטומציה שדוחפת ישירות תיחסם: זה מכוון.
- הנחיה ל-Claude בכרום:
```
פתח https://github.com/lalomavi-collab/LALUMap/settings/rules/new?target=branch .
הגדר: Ruleset Name = protect-main. Enforcement status = Active.
תחת "Target branches" לחץ "Add target" ובחר "Include default branch" (או "Include by pattern" עם main).
תחת "Rules" סמן רק: "Restrict deletions", "Block force pushes", "Require a pull request before merging" (השאר Required approvals = 0), "Require status checks to pass" (לחץ "Add checks" ובחר את הבדיקות שמופיעות ברשימה, ואם אין, השאר ריק ודווח לי).
אל תוסיף Bypass list. לפני הלחיצה על "Create" עצור והצג לי את כל ההגדרות. אחרי "אשר" לחץ "Create".
```
- תנאי הצלחה: ב-https://github.com/lalomavi-collab/LALUMap/settings/rules מופיע `protect-main` במצב Active.

### א3. PR 3 הישן

- עמוד: https://github.com/lalomavi-collab/LALUMap/pull/3
- למה: הוא פתוח ומצביע על הענף הישן.
- הנחיה ל-Claude בכרום:
```
פתח https://github.com/lalomavi-collab/LALUMap/pull/3 . הצג לי את הכותרת, התאריך והסטטוס של הבדיקות, ואל תלחץ על שום דבר. אחרי שאחליט, אכתוב "סגור" או "העבר ל-main".
אם "סגור": לחץ "Close pull request". אם "העבר ל-main": לחץ "Edit" ליד הכותרת, שנה את ה-base ל-main ושמור.
```

### א4. כתוב לי "חלק א בוצע"

אאמת מול GitHub שברירת המחדל היא main ושה-PR 28 מצביע עליו.

---

## חלק ב: אימות, פריסה והקשחה

### ב1. יצירת ענף QA ב-Supabase

- עמוד: https://supabase.com/dashboard/project/meoymkcotomoluwlwues/branches
- למה: להריץ את בדיקות האבטחה בסביבה שלא נוגעת בפרודקשן.
- שים לב: הענפים (Branching) זמינים בתוכנית Pro ומעלה ועלולים לדרוש חיבור GitHub. אם מופיעה דרישה כזאת או עלות, עצור ודווח.
- הנחיה ל-Claude בכרום:
```
פתח https://supabase.com/dashboard/project/meoymkcotomoluwlwues/branches .
לחץ "Create branch" (או "Create persistent branch"). שם: qa-billing-trust. אם מוצגת עלות או דרישה לחבר GitHub, עצור והצג אותה לי.
אחרי "אשר" לחץ Create והמתן עד שהענף מופיע עם סטטוס "Healthy" (עד כמה דקות). אל תריץ שום דבר על הענף הראשי.
דווח את שם הענף ואת הכתובת של לוח הבקרה שלו (project ref).
```

### ב2. הרצת בדיקות האבטחה על הענף

- עמוד הקובץ הגולמי: https://github.com/lalomavi-collab/LALUMap/raw/claude/hopeful-thompson-t7cq8t/supabase/tests/live_model/security.sql
- עמוד העריכה: ה-SQL Editor של **ענף ה-QA** (כתובת מהצעד הקודם, בתבנית https://supabase.com/dashboard/project/REF_של_הענף/sql/new).
- למה: לוודא מול הסכמה האמיתית שבידוד הלקוחות, פנקס הנאמנות ונעילות החיוב עובדים.
- הנחיה ל-Claude בכרום:
```
פתח את הקובץ https://github.com/lalomavi-collab/LALUMap/raw/claude/hopeful-thompson-t7cq8t/supabase/tests/live_model/security.sql , בחר את כל התוכן (Ctrl+A) והעתק (Ctrl+C).
פתח את ה-SQL Editor של ענף qa-billing-trust (לא של הפרויקט הראשי: ודא בראש הלוח שנבחר הענף), צור "New query", הדבק והרץ "Run" פעם אחת.
תוצאה מצופה: שורה אחת "OK: 20 checks passed, nothing was kept (transaction rolled back)".
אם מופיעה שגיאה: אל תנסה לתקן. צלם את הודעת השגיאה במלואה, ואז הרץ בשאילתה חדשה את הפקודה  rollback;  ודווח לי.
```
- אם יש שגיאה, שלח לי אותה: אתאים את ההכנה (לדוגמה עמודה חובה חדשה בטבלת המשרדים).

### ב3. ייצוא המיגרציות החיות לקוד (טרמינל, לא כרום)

- למה: מודל החיוב והנאמנות קיים רק בבסיס הנתונים. בלי ייצוא אין שחזור ואין סקירה.
- תיעוד: https://supabase.com/docs/guides/local-development/cli/getting-started
- בטרמינל, בתיקיית `desktop-tutorial/lalum-app`:
```
supabase login
supabase link --project-ref meoymkcotomoluwlwues
supabase db pull
```
- העבר את הקבצים החדשים ל-`lalum-app/supabase/migrations/`, פתח PR נפרד (בכותרת "ייצוא מיגרציות חיות"), וכתוב לי כשנפתח.

### ב4. החלטות (בצ'אט, לא כרום)

כתוב לי:
1. **GAP-1:** האם לבנות פונקציה מוגבלת לשותף ששחררת שעות מחויבות כשחשבונית מבוטלת בזיכוי (**א**), או להשאיר כך (**ב**)?
2. **תעריף שעתי בחשבון העסקה:** מספיק להציג שורות (תיאור, כמות, מחיר), או להוסיף תעריף לטבלת השעות?
3. **אישור נאמנות:** להשאיר `TR-000001` או לעבור ל-`TR-2026-001`?
4. **מספר תיק בית משפט ועורך דין מטפל:** להשאיר כפרמטר להפקה (אינם נשמרים)?
5. **איפה לארח את שרת ה-PDF:** Cloud Run, Fly.io או שרת שלך?

### ב5. מיזוג PR 28

- עמוד: https://github.com/lalomavi-collab/LALUMap/pull/28
- רק אחרי ב2 עבר ללא שגיאה.
- הנחיה ל-Claude בכרום:
```
פתח https://github.com/lalomavi-collab/LALUMap/pull/28 . ודא שה-base הוא main ושכל הבדיקות בתחתית העמוד ירוקות. אל תלחץ על שום דבר ודווח לי.
אחרי שאכתוב "אשר מיזוג": לחץ "Ready for review", ואז "Merge pull request" ו-"Confirm merge". אל תמחק את הענף.
```

### ב6. פריסה של פונקציית ה-Edge (טרמינל)

- עמוד לבדיקה: https://supabase.com/dashboard/project/meoymkcotomoluwlwues/functions
- פקודה (בתיקיית `LALUMap`, אחרי ב5):
```
supabase functions deploy lalum-billing-doc --project-ref meoymkcotomoluwlwues
```
- אחרי הפריסה הפונקציה אמורה להופיע ברשימה ב-Functions. את שרת ה-PDF אכין אחרי ההחלטה על אחסון (ב4.5).

### ב7. הקשחת הרשאות כניסה

- עמוד: https://supabase.com/dashboard/project/meoymkcotomoluwlwues/auth/providers
- הנחיה ל-Claude בכרום:
```
פתח https://supabase.com/dashboard/project/meoymkcotomoluwlwues/auth/providers , פתח את הספק Email, ומצא את ההגדרה "Leaked password protection" (או "Prevent use of leaked passwords"). אם היא כבויה, הפעל אותה ולחץ Save. אם אינה קיימת בעמוד, עצור ודווח (ייתכן שדורש תוכנית Pro).
```

### ב8. מחיקת הענף הישן (רק אחרי חלק א)

- עמוד: https://github.com/lalomavi-collab/LALUMap/branches
- הנחיה ל-Claude בכרום:
```
פתח https://github.com/lalomavi-collab/LALUMap/branches . ודא שברירת המחדל היא main. מצא את claude/customer-notification-rea-failure-u8x03o וצלם את שורת הענף. אל תמחק עד שאכתוב "אשר".
אחרי "אשר": לחץ על סמל הפח באותה שורה ואשר.
```

### ב9. אימות סופי

כתוב לי "הכל בוצע". אבדוק: ברירת מחדל והגנה, מצב PR 28, שתצלום הפריסה והתוצאה של ב2 תואמים, ואעדכן את רשימת הפתוחים.
