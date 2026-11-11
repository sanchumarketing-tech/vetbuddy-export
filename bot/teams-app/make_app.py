"""Build the Teams app package:  python make_app.py <BOT_APP_ID>  ->  SanchuSalesBot.zip"""
import json, sys, zipfile, uuid, pathlib
bot_id = sys.argv[1].strip()
here = pathlib.Path(__file__).parent
manifest = {
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17", "version": "1.0.0",
  "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "sanchu-sales-bot/" + bot_id)),
  "developer": {"name": "Sanchu Pet Hospitals", "websiteUrl": "https://sanchu.co.in",
                "privacyUrl": "https://sanchu.co.in", "termsOfUseUrl": "https://sanchu.co.in"},
  "name": {"short": "Sanchu Sales", "full": "Sanchu Sales Bot"},
  "description": {"short": "Ask about Sanchu sales in plain words",
                  "full": "Answers sales questions (clinics, Vet on Wheels, pharmacy, targets) from the Daily Sales Report and VetBuddy data. Mention @Sanchu Sales with a question."},
  "icons": {"color": "color.png", "outline": "outline.png"},
  "accentColor": "#1F6F5C",
  "bots": [{"botId": bot_id, "scopes": ["groupChat"], "isNotificationOnly": False, "supportsFiles": False,
            "commandLists": [{"scopes": ["groupChat"], "commands": [
              {"title": "help", "description": "What I can answer"},
              {"title": "usage", "description": "Today's free AI usage"},
              {"title": "wrong", "description": "Forget my last answer"}]}]}],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
out = here / "SanchuSalesBot.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("manifest.json", json.dumps(manifest, indent=2))
    z.write(here / "color.png", "color.png"); z.write(here / "outline.png", "outline.png")
print("built", out)
