# API-00 (database half): Hostinger proof, step by step

**Kya hai:** ek chhota throw-away app (`jewelvault-proof`) aur ek throw-away database Hostinger par banate hain, taaki hum asli server par dekh saken ki JewelVault ka database design chalega ya nahi. Sab kuch ke baad delete kar dena hai.
**Time:** 45 se 75 minute (ek jagah 30 minute rukna hai). **Kharcha:** koi nahi (Business plan mein 5 Node apps ki jagah hai, 1 use ho rahi hai).
**Account:** Chrome ka "Browser 1" (jisme Business plan wala hPanel login hai). Kuch bhi *sirf naye* database aur naye app mein hoga.

## Pehle ye 5 baatein (zaroori)

1. **Purana WordPress database `u992795260_SQXsy` aur site `flybytheway.com` ko kabhi mat chhuna.** Neeche har jagah naya naam use hoga: `proof`.
2. **Password, token ya koi secret mujhe chat mein mat bhejna.** Sirf wo text bhejna jo neeche likha hai ("Mujhe kya bhejna hai"). Report mein password hota hi nahi (maine local par check kiya).
3. **Naya database banate waqt browser purana username/password bhar deta hai** (pichli baar `gofinapro007` jaisa kuch bhara hua tha). Fields ko khud saaf karke type karo.
4. Maine Hostinger ke buttons ke naam docs aur tumhare account ke pages se liye hain. "Add Website" wala wizard maine khud nahi khola; agar koi naam thoda alag dikhe to sabse milta-julta option lo, ya screenshot bhejo.
5. Kuch bhi alag ya error dikhe: ruk jao, screenshot ya text bhejo. Aage mat badho.

## Part A: GitHub par repo (5 min)

1. **GitHub Desktop** kholo. Menu **File → Add Local Repository…** → folder chuno: `Desktop/Harsh Vishwas/Client/jewelvault-proof` → **Add Repository**.
2. Upar **Publish repository** dabao. Name: `jewelvault-proof`. **"Keep this code private" ka tick laga rehna chahiye.** Account: `iamharshvishwas`. **Publish Repository**.
3. (Ek baar dekh lo) GitHub.com → Settings → Applications → **Hostinger** → Configure: agar "Only select repositories" hai to `jewelvault-proof` add karo.

## Part B: Naya database (5 min)

4. hPanel → **Websites** → koi bhi site kholo (jaise `skyblue-rat-…`) → left menu **Databases → Management**.
5. **Create a New MySQL Database And Database User** mein:
   - **MySQL database name:** `proof`
   - **MySQL username:** `proof`
   - **Password:** password manager se ek naya strong password banao aur wahi paste karo (browser ka bhara hua text hata do).
   - **Create** dabao.
6. Neeche **List of Current MySQL Databases And Users** mein ab do rows honge. Naye wali ke **poore naam** (jaise `u992795260_proof`) note karo: "database ka naam" aur "user ka naam". Ye aage env variables mein jayenge.

## Part C: Naya Node app (10 min)

7. hPanel → **Websites → Add Website → Node.js web app → Import Git repository**. Agar GitHub connect nahi hai: **Connect with GitHub**.
8. Repository list se `jewelvault-proof` chuno (private hai to lock ka nishan dikhega). Settings:
   - **Branch:** `main`
   - **Node.js version:** `22`
   - **Root directory:** `./`
   - **Build command:** `build` (ye sirf syntax check hai, 1 second)
   - **Output directory:** khaali chhodo
   - **Entry file:** `server.js`
9. **Environment variables** ka section dikhe to ye 6 add karo (nahi dikhe to Deploy karke baad mein: left menu **Environment variables → Add environment variable**, phir **Save**; save karne se app redeploy hota hai, wo theek hai):

   | Key | Value |
   |---|---|
   | `DB_HOST` | `127.0.0.1` |
   | `DB_PORT` | `3306` |
   | `DB_NAME` | step 6 ka database ka poora naam |
   | `DB_USER` | step 6 ka user ka poora naam |
   | `DB_PASSWORD` | step 5 ka password |
   | `PROOF_TOKEN` | koi bhi lamba random text, kam se kam 24 akshar (password manager se banao). **Ye chhote ya simple mat rakhna** |

10. **Deploy** dabao. **Deployments** page par dekho kitna time laga (build time, seconds mein) aur note karo. Jab **Running** dikhe, site ka temporary naam (jaise `xxxxx.hostingersite.com`) note karo.

## Part D: Zinda hai? (2 min)

11. Browser mein kholo: `https://<temporary-naam>/`. Ek text jaisa JSON dikhna chahiye jisme `"app": "jewelvault-proof"` ho. **Ye pura text copy karke rakh lo** (isme `started_at` hai; aage kaam aayega).
    - Pehli baar mein kitne second laga khulne mein? (ghadi se dekho) Note karo.

## Part E: Database proof (3 min)

12. Kholo: `https://<temporary-naam>/proof/<PROOF_TOKEN>/run` → likha aayega `"started": true`.
13. 1 minute ruko. Phir kholo: `https://<temporary-naam>/proof/<PROOF_TOKEN>/report`. Page ko tab tak refresh karo jab tak upar `"running": false` na dikhe (lagbhag 60 se 90 second).
14. **Poora text copy karo** (select all). Isme S01 se S15 tak steps hain, har ek `pass`, `fail` ya `info`. Wahi mujhe bhejna hai.
    - Agar `"started": false` ya 403 aaye: token galat hai ya app abhi redeploy ho raha hai. Ruko, dobara try karo.

## Part F: Cron test 1, Node.js type (10 min)

15. Naye app ki site kholo → left menu **Advanced → Cron Jobs**. **Create a New Cron Job** mein **Node.js** select hona chahiye.
16. **Command to Run** ke ek hi box mein hai: left ka *grey* hissa (jaise `/opt/alt/alt-nodejs20/root/bin/node /home/u992795260/domai…`) badla nahi ja sakta. Us grey hissa ko poora padho (box ke andar click karke End dabao, ya zoom karo) aur **mujhe bata do poora kya likha hai** (isme tumhare password nahi hote). Phir right ke white box mein script ka path likho. **Teen jagah try karni pad sakti hain, ek ek karke:**
    1. `cron.js`
    2. `hbuilds/current/nodejs/cron.js`
    3. `nodejs/cron.js`
17. **Common Options** dropdown mein **Every minute** chuno. (Agar wo na mile: **Minute** dropdown mein **Every minute (\*)**, aur Hour, Day, Month, Weekday sab mein bhi "every" wala option.) **Save**.
18. 3 minute ruko. Phir kholo: `https://<temporary-naam>/proof/<PROOF_TOKEN>/cron-log`.
    - `"file"` ya `"table"` mein 1 se zyada line dikhe to cron chala. **Wo poora text copy karo** (isme Node ka version, time zone, aur ye likha hoga ki cron ko database ke settings dikhe ya nahi).
    - 3 minute baad bhi khaali hai? Cron job edit karke agla path (2 phir 3) try karo, har baar 3 minute ruko.
19. **Cron job delete kar do** (har minute chalta rahega warna). Delete ka button job ki list mein hota hai.
20. *(Optional, time zone ke liye)* Naya Node.js cron job banao, path wahi jo kaam kiya. **Hour = abhi ka UTC ghanta** (India ka time minus 5:30; jaise abhi IST 16:20 hai to UTC 10:50, hour = 10), **minute = abhi ke UTC minute + 3** (jaise 53), baaki sab `*`. 6 minute baad `/cron-log` dekho. Agar us UTC time par line aayi (`at` lagbhag 10:53 UTC) to cron UTC par chalta hai; nahi aayi to IST ya kuch aur. Bata dena kya hua. Phir ye job bhi **delete**.

## Part G: Cron test 2, Custom type with curl (5 min)

21. Cron Jobs page par ab **Custom** select karo. **Command to Run:**
    `curl -fsS "https://<temporary-naam>/cron-hit?src=custom-curl" > /dev/null 2>&1`
    Common Options → **Every minute** (ya Part F step 17 jaisa). **Save**.
22. 3 minute ruko. Kholo `https://<temporary-naam>/` : `"cron_hits_since_start"` 1 se zyada hona chahiye aur `"last_cron_hits"` mein `custom-curl` dikhna chahiye. Result bata dena (haan/nahi).
23. **Ye cron job bhi delete kar do.**

## Part H: App so jaata hai kya? (30 min ruk ke, aur iske beech Part I aur J kar sakte ho)

24. **Ab app ko 30 minute tak bilkul mat kholo** (na `/`, na `/proof/...`). Cron jobs delete ho chuke hone chahiye.
25. 30 minute baad ghadi ke saath kholo `https://<temporary-naam>/` aur note karo:
    - **Kitne second mein khula?** (pehli request)
    - `"started_at"`: agar Part D wale `started_at` se **alag** hai to app beech mein band hua tha aur dobara shuru hua (cold start). Ye bahut kaam ki baat hai.
    - `"uptime_seconds"`.
    - Dobara refresh karo: ab kitne second?

## Part I: `mariadb-dump` server par hai? (5 min, optional, aur 30 minute ke intezaar mein hi)

26. Mac ka Terminal kholo. Ye command paste karo (isme koi password nahi hai):
    `ssh -p 65002 u992795260@92.249.46.146`
    Password maangega: wo **tum khud** type karo (hPanel → Advanced → SSH Access mein hai; "Change" se naya bana sakte ho). Mujhe mat bhejna.
27. Login ke baad ye 3 commands chalao aur unka **output** copy karo:
    `which mariadb-dump mysqldump`
    `mariadb-dump --version`
    `node -v`
28. `exit` likh ke bahar aa jao.

## Part J: Database size (2 min)

29. hPanel → Databases → Management: `proof` database ke saamne jo **size** likhi hai (MB mein) wo note karo. Report ke S14 mein jo `total mb` hai usse milao. Dono lagbhag barabar hon to Hostinger index ki jagah bhi ginta hai.
30. *(Optional, Hostinger live chat par ye sawal bhej do)*: *"What is the maximum size of one MySQL database on my Business Web Hosting plan, and does the limit include index size? Also, are database backups (not files) restorable on their own?"* Unka jawab mujhe bata dena.

## Part K: Sab hata do (5 min, zaroori)

31. **Cron Jobs:** koi job bachi ho to delete.
32. **Database:** hPanel → Databases → Management → *sirf `proof` wali row* → right ka **⋮** → **Delete**. (`u992795260_SQXsy` wali row ko chhuna bhi nahi.)
33. **Node app:** Hostinger Node apps ko sirf poori website hata kar delete kiya ja sakta hai. `proof` wali site hata do (Websites → us site ki settings/delete). `flybytheway.com` aur purani `skyblue-rat-…` ko is step mein mat hatao (skyblue-rat ka alag faisla baad mein).
34. **GitHub:** `jewelvault-proof` repo delete kar do ya private rehne do (ab koi secret us mein nahi hai).
35. **Password manager:** proof wale database ka password aur token delete.

## Mujhe kya bhejna hai (sab text mein, password nahi)

| # | Kya | Kahan se |
|---|---|---|
| 1 | Part C: build time (seconds), temporary site ka naam | Deployments page |
| 2 | Part D: pehla `/` ka poora text, aur kitne second mein khula | browser |
| 3 | **Part E: `/report` ka poora text** | browser |
| 4 | Part F: cron Node.js type ka grey path wala hissa, kaun sa path chala, `/cron-log` ka text | hPanel, browser |
| 5 | Part F step 20 (optional): UTC time par chala ya nahi | browser |
| 6 | Part G: curl cron: haan/nahi, `cron_hits_since_start` kitna | browser |
| 7 | Part H: 30 minute baad kitne second, `started_at` badla ya nahi | browser |
| 8 | Part I (optional): 3 commands ka output | Terminal |
| 9 | Part J: hPanel mein size (MB), aur chat ka jawab (optional) | hPanel |

## Report mein kya kya check hota hai (taaki padhne par samajh aaye)

| Step | Kya dekhta hai | Pass ka matlab |
|---|---|---|
| S01 | app ko kya dikhta hai: env variable *naam* (value nahi), Node version, memory limit, time zone | sab 4 DB settings maujood |
| S02 | `127.0.0.1`, `localhost`, `srv2210.hstgr.io`, IP: kaun sa naam database se jud sakta hai | jo env mein diya wo chala |
| S03 | database ke settings aur is user ke rights | (sirf jaankari) |
| S04 | har connection par lagne wali 6 settings set ho sakti hain | sab ok |
| S05 | **asli JewelVault schema aur seeds is database par lagte hain** (25 tables, native UUID) | UUID type chalta hai |
| S06 | `CREATE TRIGGER` ban sakta hai aur chalta hai | triggers allowed |
| S07 | audit_log append-only triggers lagte hain aur chalte hain | ok |
| S08 | constraints asli server par: PAN capital, Credit mode nahi, Sold ke liye bill, 4 photos refuse, out-of-range refuse | sab refuse hue |
| S09 | bill number bina gap ke (4 connections), pehle-insert wala jaal, aur 8 connections ek lock order mein | 0 deadlock, gap nahi |
| S10 | lock timeout (1205) aur statement time limit (1969) | dono hue |
| S11 | 2 MiB photo andar-bahar bilkul wahi; 1 byte zyada refuse | ok |
| S12 | app se database tak kitne millisecond (server India mein) | (sirf jaankari) |
| S13 | 25 second idle chhodne par connection ka kya hua (Hostinger 20 second par kaat-ta hai); pool theek ho jaata hai | pool bina error ke |
| S14 | database ka size (data + index) | (sirf jaankari) |
| S15 | app se bahar internet (sirf jaankari: backup ab R2 par nahi, plan ke folder mein jaata hai). R2 wali line par `ERR_SSL` aana normal hai (naam nakli hai) | kam se kam ek ok |

`"verdicts"` mein sabse zaroori jawab ek jagah likhe aate hain.
