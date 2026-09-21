@echo off
REM One-time setup: virtual environment, dependencies, full data + model pipeline.
setlocal
cd /d "%~dp0.."
set "ROOT=%CD%"

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required but was not found on PATH.
  exit /b 1
)

echo ==^> Creating virtual environment (.venv)
python -m venv .venv
if errorlevel 1 exit /b 1

call .venv\Scripts\activate.bat

echo ==^> Installing dependencies
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt
if errorlevel 1 exit /b 1

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo ==^> Wrote .env ^(copy of .env.example^)
)

set "PYTHONPATH=%ROOT%\src"

echo ==^> Building dataset, warehouse, features, models and scores
echo     ^(this takes roughly 3-5 minutes on a laptop^)
python -m attrition.cli pipeline
if errorlevel 1 exit /b 1

echo.
echo Setup complete.
echo.
echo Start the app with:
echo     scripts\run.bat
echo then open http://127.0.0.1:8000
echo.
echo Sign in with:
echo     admin      / Admin@2026
echo     hr.manager / HrManager@2026
echo     viewer     / Viewer@2026
endlocal
