@echo off
REM Used by Windows Task Scheduler. Runs the export from this script's folder.
cd /d "%~dp0"
REM Make sure the needed Python packages are installed (quick if already there)
python -m pip install --quiet --disable-pip-version-check requests xlrd openpyxl "psycopg[binary]" >nul 2>&1
python vetbuddy_sales_export.py
exit /b %ERRORLEVEL%
