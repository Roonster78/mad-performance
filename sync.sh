#!/bin/sh
# copy both apps from the project folder into this repo (without zip archives)
for a in dashboard webapp; do rm -rf "./$a"; cp -r "/mnt/project-files/$a" "./$a"; rm -f "./$a"/*.zip; done
