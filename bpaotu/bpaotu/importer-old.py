import os
import csv
import tempfile
import traceback
import logging
import sqlalchemy
from sqlalchemy.schema import CreateSchema, DropSchema
from sqlalchemy.sql.expression import text
from hashlib import md5
from sqlalchemy.orm import sessionmaker
from glob import glob
from .contextual import (
    marine_contextual_rows,
    soil_contextual_rows,
    soil_field_spec,
    marine_field_specs)
from collections import (
    defaultdict,
    OrderedDict)
from itertools import zip_longest
from .models import (
    ImportSamplesMissingMetadataLog,
    ImportFileLog,
    ImportOntologyLog)
from .otu import (
    Base,
    Environment,
    OTUAmplicon,
    OTUKingdom,
    OTUPhylum,
    OTUClass,
    OTUOrder,
    OTUFamily,
    OTUGenus,
    OTUSpecies,

    # w: Including OTU to write directly to it.
    OTU,

    # sample_contextuals
    SampleContext,
    SampleHorizonClassification,
    SampleStorageMethod,
    SampleLandUse,
    SampleEcologicalZone,
    SampleVegetationType,
    SampleProfilePosition,
    SampleAustralianSoilClassification,
    SampleFAOSoilClassification,
    SampleTillage,
    SampleType,
    SampleColor,

    # edna phase 3
    SampleEnvironmentalMaterial1,
    SampleEnvironmentalMaterial2,

    SCHEMA,
    make_engine)

# w: for clearing sample_otu cache upon import.
from django.core.cache import caches
from hashlib import sha256
import re

# post import calculations
from .query import(
    EdnaPostImport
)

logger = logging.getLogger("rainbow")


def try_int(s):
    try:
        return int(s)
    except ValueError:
        return None


def grouper(iterable, n, fillvalue=None):
    "Collect data into fixed-length chunks or blocks"
    # grouper('ABCDEFG', 3, 'x') --> ABC DEF Gxx"
    args = [iter(iterable)] * n
    return zip_longest(*args, fillvalue=fillvalue)


def otu_hash(code):
    return md5(code.encode('ascii')).digest()

def site_hash(code):
    return md5(code.encode('ascii')).digest()

class DataImporter:
    soil_ontologies = OrderedDict([
        ('environment', Environment),
        ('sample_type', SampleType),
        ('horizon_classification', SampleHorizonClassification),
        ('soil_sample_storage_method', SampleStorageMethod),
        ('broad_land_use', SampleLandUse),
        ('detailed_land_use', SampleLandUse),
        ('general_ecological_zone', SampleEcologicalZone),
        ('vegetation_type', SampleVegetationType),
        ('profile_position', SampleProfilePosition),
        ('australian_soil_classification', SampleAustralianSoilClassification),
        ('fao_soil_classification', SampleFAOSoilClassification),
        ('immediate_previous_land_use', SampleLandUse),
        ('tillage', SampleTillage),
        ('color', SampleColor),
    ])

    marine_ontologies = OrderedDict([
        ('environment', Environment),
        ('sample_type', SampleType),
    ])

    edna_sample_ontologies = OrderedDict([
        ('sample_type', SampleType),
        ('sample_environmental_feature1', SampleEnvironmentalMaterial1),
        ('sample_environmental_feature2', SampleEnvironmentalMaterial2)
    ])

    def __init__(self, import_base):
        self._clear_import_log()
        self._engine = make_engine()
        Session = sessionmaker(bind=self._engine)
        self._create_extensions()
        self._session = Session()
        self._import_base = import_base
        try:
            self._session.execute(DropSchema(SCHEMA, cascade=True))
        except sqlalchemy.exc.ProgrammingError:
            self._session.invalidate()
        self._session.execute(CreateSchema(SCHEMA))
        self._session.commit()
        Base.metadata.create_all(self._engine)

    def _clear_import_log(self):
        logger.critical("Clearing import log")
        for log_cls in (ImportSamplesMissingMetadataLog, ImportFileLog, ImportOntologyLog):
            log_cls.objects.all().delete()

    def _create_extensions(self):
        extensions = ('citext',)
        for extension in extensions:
            try:
                logger.info("creating extension: %s" % extension)
                self._engine.execute('CREATE EXTENSION %s;' % extension)
            except sqlalchemy.exc.ProgrammingError as e:
                if 'already exists' not in str(e):
                    logger.critical("couldn't create extension: %s (%s)" % (extension, e))

    def _read_tab_file(self, fname):
        with open(fname) as fd:
            reader = csv.DictReader(fd, dialect="excel-tab")
            yield from reader

    def _build_ontology(self, db_class, vals):
        for val in sorted(vals):
            instance = db_class(value=val)
            self._session.add(instance)
        self._session.commit()
        return dict((t.value, t.id) for t in self._session.query(db_class).all())

    def _load_ontology(self, ontology_defn, row_iter):
        '''
        import the ontologies, and build a mapping from
        permitted values into IDs in those ontologies
        '''
        by_class = defaultdict(list)
        for field, db_class in ontology_defn.items():
            by_class[db_class].append(field)

        # each unique category for an a classification level.
        # w: goes through the list of categories under an item
        # w: if the row contains one of them add the value to the set.
        vals = defaultdict(set)
        for row in row_iter:
            for db_class, fields in by_class.items():
                # logger.info(fields)
                for field in fields:
                    if field in row:
                        vals[db_class].add(row[field])

        mappings = {}
        for db_class, fields in by_class.items():
            map_dict = self._build_ontology(db_class, vals[db_class])
            for field in fields:
                mappings[field] = map_dict
        return mappings

    @classmethod
    def classify_fields(cls, environment_lookup):
        # flip around to name -> id
        pl = dict((t[1], t[0]) for t in environment_lookup.items())
        soil_fields = set()
        marine_fields = set()
        for field_info in soil_field_spec:
            field_name = field_info[0]
            if field_name in DataImporter.soil_ontologies:
                field_name += '_id'
            soil_fields.add(field_name)
        for data_type, fields in marine_field_specs.items():
            for field_info in fields:
                field_name = field_info[0]
                if field_name in DataImporter.marine_ontologies:
                    field_name += '_id'
                marine_fields.add(field_name)
        soil_only = soil_fields - marine_fields
        marine_only = marine_fields - soil_fields
        r = {}
        r.update((t, pl['Soil']) for t in soil_only)
        r.update((t, pl['Marine']) for t in marine_only)
        return r

    def load_otu_abundance(self, otu_lookup, site_lookup):
        '''
        Loads in the abundance data and populates the sample_otu table. Added custom site_lookup hashtable because our data refers to the sites as codes rather than ids
        '''

        def otu_rows(fd):
            reader = csv.reader(fd, dialect='excel-tab')
            header = next(reader)
            # there's taxonomy and control information in the last few columns. this can be
            # excluded from the import: we skip until we hit a non-integer header
            bpa_ids = [try_int(t.split('/')[-1]) for t in header[1:]]
            try:
                valid_until = bpa_ids.index(None)
                bpa_ids = bpa_ids[:valid_until]
            except ValueError:
                pass
            return bpa_ids, reader

        # w: grabs all the site ids in the database, compares to the ones in the file. Adds the missing ones to the site table.
        def _missing_bpa_ids(fname):
            have_bpaids = set([t[0] for t in self._session.query(SampleContext.id)])
            with open(fname, 'r') as fd:
                bpa_ids, _ = otu_rows(fd)
                for bpa_id in bpa_ids:
                    if bpa_id not in have_bpaids:
                        yield bpa_id

        def _make_sample_otus(fname, skip_missing):
            # note: (for now) we have to cope with duplicate columns in the input files.
            # we just make sure they don't clash, and this can be reported to CSIRO
            with open(fname, 'r') as fd:
                bpa_ids, reader = otu_rows(fd)
                for (imported, row) in enumerate(reader):
                    otu_id = otu_lookup[otu_hash(row[0])]
                    to_make = {}
                    for bpa_id, count in zip(bpa_ids, row[1:]):
                        if count == '' or count == '0' or count == '0.0':
                            continue
                        if bpa_id in skip_missing:
                            continue
                        count = int(float(count))
                        if bpa_id in to_make and to_make[bpa_id] != count:
                            raise Exception("conflicting OTU data, abort.")
                        to_make[bpa_id] = count
                    for bpa_id, count in to_make.items():
                        yield [bpa_id, otu_id, count]
                ImportFileLog.make_file_log(fname, file_type='Abundance', rows_imported=imported, rows_skipped=0)

        # w: Goes through all the .txt files
        logger.warning('Loading OTU abundance tables')
        missing_bpa_ids = set()
        for fname in glob(self._import_base + '/*/*.txt'):
            logger.warning("first pass, reading from: %s" % (fname))
            missing_bpa_ids |= set(_missing_bpa_ids(fname))

        if missing_bpa_ids:
            il = ImportSamplesMissingMetadataLog(samples_without_metadata=list(sorted(missing_bpa_ids)))
            il.save()

        for sampleotu_fname in glob(self._import_base + '/*/*.txt'):
            try:
                logger.warning("second pass, reading from: %s" % (sampleotu_fname))
                with tempfile.NamedTemporaryFile(mode='w', dir='/data', prefix='bpaotu-', delete=False) as temp_fd:
                    fname = temp_fd.name
                    os.chmod(fname, 0o644)
                    logger.warning("writing out OTU abundance data to CSV tempfile: %s" % fname)
                    w = csv.writer(temp_fd)
                    w.writerow(['sample_id', 'otu_id', 'count'])
                    w.writerows(_make_sample_otus(sampleotu_fname, missing_bpa_ids))
                logger.warning("loading OTU abundance data from temporary CSV file")
                try:
                    self._engine.execute(
                        text('''COPY otu.sample_otu from :csv CSV header''').execution_options(autocommit=True),
                        csv=fname)
                except:  # noqa
                    logger.critical("unable to import %s" % (sampleotu_fname))
                    traceback.print_exc()
            finally:
                os.unlink(fname)

def load_soil_contextual_metadata(self):
        """Loads the soil.xlsx into rows variable. Then maps the soil ontologies to the rows"""

        logger.warning("loading Soil contextual metadata")

        def _make_context():
            for row in rows:
                bpa_id = row['bpa_id']
                if bpa_id is None:
                    continue
                attrs = {
                    'id': int(bpa_id.split('.')[-1])
                }
                for field in DataImporter.soil_ontologies:
                    if field not in row:
                        continue
                    attrs[field + '_id'] = mappings[field][row[field]]
                for field, value in row.items():
                    if field in attrs or (field + '_id') in attrs or field == 'bpa_id':
                        continue
                    attrs[field] = value
                yield SampleContext(**attrs)

        rows = soil_contextual_rows(glob(self._import_base + '/base/*.xlsx')[0])
        mappings = self._load_ontology(DataImporter.soil_ontologies, rows)
        self._session.bulk_save_objects(_make_context())

    def load_marine_contextual_metadata(self):
        """Loads the marine.xlsx into rows variable. Then maps the marine ontologies to the rows"""

        logger.warning("loading Marine contextual metadata")

        def _make_context():
            for row in rows:
                bpa_id = row['bpa_id']
                if bpa_id is None:
                    continue
                attrs = {
                    'id': int(bpa_id.split('.')[-1])
                }
                for field in DataImporter.marine_ontologies:
                    if field not in row:
                        continue
                    attrs[field + '_id'] = mappings[field][row[field]]
                for field, value in row.items():
                    if field in attrs or (field + '_id') in attrs or field == 'bpa_id':
                        continue
                    attrs[field] = value
                yield SampleContext(**attrs)

        rows = marine_contextual_rows(glob(self._import_base + '/mm/*.xlsx')[0])
        mappings = self._load_ontology(DataImporter.marine_ontologies, rows)
        self._session.bulk_save_objects(_make_context())
        self._session.commit()
    def load_taxonomies(self):
        '''
        Loads up the taxonomies.
        w: It does this by taking .taxonomy and the codes as input, making a csv then executing a postgres COPY command to transfer the temp.csv data into the OTU table.
        '''
        # md5(otu code) -> otu ID, returned
        otu_lookup = {}
        ontologies = OrderedDict([
            ('kingdom', OTUKingdom),
            ('phylum', OTUPhylum),
            ('class', OTUClass),
            ('order', OTUOrder),
            ('family', OTUFamily),
            ('genus', OTUGenus),
            ('species', OTUSpecies),
            ('amplicon', OTUAmplicon),
        ])

        def _taxon_rows_iter():
            for fname in glob(self._import_base + '/*/*.taxonomy'):
                logger.warning('reading taxonomy file: %s' % fname)
                imported = 0
                with open(fname) as fd:
                    for row in csv.reader(fd, dialect='excel-tab'):
                        if row[0].startswith('#'):
                            continue
                        otu = row[0]
                        ontology_parts = row[1:]
                        if len(ontology_parts) > len(ontologies):
                            # work-around: duplicated species column; reported to CSIRO
                            ontology_parts = ontology_parts[:len(ontologies) - 1] + [ontology_parts[-1]]
                        elif len(ontology_parts) < len(ontologies):
                            # work-around: short rows; reported to CSIRO
                            ontology_parts = ontology_parts[:-1] + [''] * (len(ontologies) - len(ontology_parts)) + [ontology_parts[-1]]
                        assert(len(ontology_parts) == len(ontologies))
                        obj = dict(zip(ontologies.keys(), ontology_parts))
                        obj['otu'] = otu
                        imported += 1
                        yield obj
                ImportFileLog.make_file_log(fname, file_type='Taxonomy', rows_imported=imported, rows_skipped=0)

        logger.warning("loading taxonomies - pass 1, defining ontologies")
        mappings = self._load_ontology(ontologies, _taxon_rows_iter())

        logger.warning("loading taxonomies - pass 2, defining OTUs")
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir='/data', prefix='bpaotu-', delete=False) as temp_fd:
                fname = temp_fd.name
                os.chmod(fname, 0o644)
                logger.warning("writing out taxonomy data to CSV tempfile: %s" % fname)
                w = csv.writer(temp_fd)
                # w: creates header for the temp file.
                w.writerow(['id', 'code', 'kingdom_id', 'phylum_id', 'class_id', 'order_id', 'family_id', 'genus_id', 'species_id', 'amplicon_id'])
                # w: For every row in the .taxonomy file starting at 1 (Not 0) do the following.
                for _id, row in enumerate(_taxon_rows_iter(), 1):
                    otu_lookup[otu_hash(row['otu'])] = _id
                    out_row = [_id, row['otu']]
                    for field in ontologies:
                        if field not in row:
                            out_row.append('')
                        else:
                            out_row.append(mappings[field][row[field]])
                    w.writerow(out_row)
            logger.warning("loading taxonomy data from temporary CSV file")
            self._engine.execute(
                text('''COPY otu.otu from :csv CSV header''').execution_options(autocommit=True),
                csv=fname)
        finally:
            os.unlink(fname)
        return otu_lookup

         self._session.commit()
