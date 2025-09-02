# MCR-Sync
A small app for synchronizing routes between docker containers and [mc-router](https://github.com/itzg/mc-router/).

This app uses the label `router.slug` to determine the subdomain that will prefix each domain suffix that is set in `config.yml`.

I personally use this to synchronize routes between my pterodactyl/pelican instance to mc-router automatically through the set labels.
